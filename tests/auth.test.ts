// Accounts, sessions, the route gate, and send attribution.
import { expect, test } from "bun:test";
import { join } from "node:path";

process.env.DB_PATH = ":memory:";
process.env.SENDER_ORG = "";
process.env.SENDER_POSTAL_ADDRESS = "1 Test St, Huntsville AL";
process.env.DRY_RUN = "1";

const auth = await import("../src/auth.ts");
const { config } = await import("../src/config.ts");
const { db, setSetting } = await import("../src/db.ts");
const repo = await import("../src/repo.ts");
const { enqueue } = await import("../src/mail/queue.ts");
const { senderNameFor, contextFor } = await import("../src/mail/render.ts");
const { routes } = await import("../src/web/routes.ts");
const { sessionCookie } = await import("./helper.ts");
const { displayNameFor } = await import("../src/mail/render.ts");

const CAMPAIGN = "auth-test";
db.query(`INSERT OR IGNORE INTO campaigns (name) VALUES (?)`).run(CAMPAIGN);

// --- accounts ---------------------------------------------------------------

test("a username is validated and a short password refused", async () => {
  await expect(auth.createStudent("A", "no", "longenoughpassword")).rejects.toThrow(/Username/);
  await expect(auth.createStudent("A", "goodname", "short")).rejects.toThrow(/at least 10/);
});

test("usernames are unique and case-insensitive", async () => {
  await auth.createStudent("Alice R", "alice", "alice-password-1");
  await expect(auth.createStudent("Other", "ALICE", "another-password")).rejects.toThrow(/taken/);
});

/** Narrows the login union, failing the test rather than the type check. */
const signIn = async (username: string, password: string) => {
  const r = await auth.login(username, password);
  if (!r.ok) throw new Error(`expected a session, got "${r.reason}"`);
  return r;
};

test("a correct password opens a session and a wrong one does not", async () => {
  expect(await auth.login("alice", "wrong-password-x"))
    .toMatchObject({ ok: false, reason: "credentials" });
  const s = await signIn("alice", "alice-password-1");
  expect(auth.studentForToken(s.token)?.username).toBe("alice");
});

test("an unknown username is refused without saying so", async () => {
  // The same reason as a wrong password: naming which was wrong would say
  // which usernames exist.
  expect(await auth.login("nobody", "alice-password-1"))
    .toMatchObject({ ok: false, reason: "credentials" });
});

test("signing out invalidates that token immediately", async () => {
  const s = await signIn("alice", "alice-password-1");
  auth.logout(s.token);
  expect(auth.studentForToken(s.token)).toBeNull();
});

test("changing a password ends every existing session", async () => {
  const a = await signIn("alice", "alice-password-1");
  const b = await signIn("alice", "alice-password-1");
  await auth.setPassword(auth.studentForToken(a.token)!.id, "alice-password-2");
  expect(auth.studentForToken(a.token)).toBeNull();
  expect(auth.studentForToken(b.token)).toBeNull();
  expect((await auth.login("alice", "alice-password-2")).ok).toBe(true);
});

test("deactivating an account kills its sessions and blocks sign-in", async () => {
  const s = await signIn("alice", "alice-password-2");
  const id = auth.studentForToken(s.token)!.id;
  auth.setActive(id, false);
  expect(auth.studentForToken(s.token)).toBeNull();
  // Specific, not vague: only someone who knows the password gets this far.
  expect(await auth.login("alice", "alice-password-2"))
    .toMatchObject({ ok: false, reason: "deactivated" });
  auth.setActive(id, true);
});

test("the last active admin cannot be demoted or deactivated", async () => {
  // Create ours FIRST, then demote the others -- demoting down to zero would
  // trip the very guard under test partway through the loop.
  const soleId = await auth.createStudent("Sole Admin", "soleadmin", "sole-password-1", "admin");
  for (const a of auth.listStudents()
        .filter((s) => s.role === "admin" && s.active && s.id !== soleId)) {
    auth.setRole(a.id, "student");
  }

  expect(() => auth.setRole(soleId, "student")).toThrow(/only active admin/);
  expect(() => auth.setActive(soleId, false)).toThrow(/only active admin/);

  // With a second admin present the guard lifts.
  const second = await auth.createStudent("Second Admin", "secondadmin", "second-password-1", "admin");
  auth.setActive(soleId, false);
  expect(auth.getStudent(soleId)!.active).toBe(0);
  expect(auth.getStudent(second)!.role).toBe("admin");
});

// --- sign-up ----------------------------------------------------------------

/** A same-origin form POST, unauthenticated -- how a new user reaches /signup. */
const signupPost = (body: Record<string, string>) =>
  routes.request("http://localhost/signup", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded",
               origin: "http://localhost" },
    body: new URLSearchParams(body).toString(),
  });

test("signing up files a request -- no session, no account yet", async () => {
  const res = await signupPost({ name: "Cass M", username: "cass", password: "cass-password-1" });

  expect(res.status).toBe(302);
  // Not "/": there is nothing to go to yet.
  expect(new URL(res.headers.get("location")!, "http://localhost").pathname).toBe("/signup");
  expect(res.headers.get("set-cookie")).toBeNull();

  // It is not an account...
  expect(auth.listStudents().some((s) => s.username === "cass")).toBe(false);
  // ...it is a request, with the name the admin will be shown.
  const req = auth.pendingRequests().find((s) => s.username === "cass")!;
  expect(req.name).toBe("Cass M");
  expect(req.approved_at).toBeNull();
  expect(req.role).toBe("student");

  // And it cannot be used, however right the password is.
  expect(await auth.login("cass", "cass-password-1"))
    .toMatchObject({ ok: false, reason: "pending" });
});

test("an admin approves a request, and only then can it sign in", async () => {
  const admin = auth.listStudents().find((s) => s.role === "admin" && s.active)!;
  const req = auth.pendingRequests().find((s) => s.username === "cass")!;

  auth.approveStudent(req.id, admin.id);

  const approved = auth.getStudent(req.id)!;
  expect(approved.approved_at).not.toBeNull();
  expect(approved.approved_by).toBe(admin.id);
  expect(auth.pendingRequests().some((s) => s.username === "cass")).toBe(false);
  expect(auth.listStudents().some((s) => s.username === "cass")).toBe(true);
  expect((await auth.login("cass", "cass-password-1")).ok).toBe(true);

  // Approving twice is a mistake worth naming, not a silent no-op.
  expect(() => auth.approveStudent(req.id, admin.id)).toThrow(/already approved/);
});

test("declining removes the request and frees the username", async () => {
  await signupPost({ name: "Walk In", username: "walkin", password: "walkin-password-1" });
  const req = auth.pendingRequests().find((s) => s.username === "walkin")!;

  auth.declineStudent(req.id);
  expect(auth.getStudent(req.id)).toBeNull();

  // The name is free, so an honest mistake can simply ask again.
  await signupPost({ name: "Walk In", username: "walkin", password: "walkin-password-2" });
  expect(auth.pendingRequests().some((s) => s.username === "walkin")).toBe(true);
});

test("decline cannot be pointed at an account someone already approved", async () => {
  const live = auth.listStudents().find((s) => s.username === "cass")!;
  expect(() => auth.declineStudent(live.id)).toThrow(/Deactivate it instead/);
  expect(auth.getStudent(live.id)).not.toBeNull();
});

test("a session dies the moment the account behind it is un-approved", async () => {
  const s = await signIn("cass", "cass-password-1");
  expect(auth.studentForToken(s.token)?.username).toBe("cass");

  // Nothing in the UI does this -- the point is that the gate is checked on
  // every request, not only at sign-in.
  db.query(`UPDATE students SET approved_at = NULL WHERE username = 'cass'`).run();
  expect(auth.studentForToken(s.token)).toBeNull();
  db.query(`UPDATE students SET approved_at = datetime('now') WHERE username = 'cass'`).run();
});

test("a self-signup is a student -- admin is granted, never chosen", async () => {
  // An extra role field in the POST must not be honoured.
  await signupPost({ name: "Dee P", username: "deep", password: "deep-password-1",
                     role: "admin" });
  expect(auth.pendingRequests().find((s) => s.username === "deep")!.role).toBe("student");
});

test("a rejected sign-up says why and keeps what was typed", async () => {
  const res = await signupPost({ name: "Cass Twin", username: "cass", password: "other-password" });
  expect(res.status).toBe(302);

  const loc = new URL(res.headers.get("location")!, "http://localhost");
  expect(loc.pathname).toBe("/signup");
  expect(loc.searchParams.get("err")).toMatch(/taken/);
  expect(loc.searchParams.get("name")).toBe("Cass Twin");
  expect(loc.searchParams.get("username")).toBe("cass");
  expect(res.headers.get("set-cookie")).toBeNull();

  // ...and the page renders that message rather than swallowing it.
  const page = await routes.request("http://localhost" + res.headers.get("location"));
  expect(page.status).toBe(200);
  expect(await page.text()).toContain("is taken");
});

test("a short password is refused and no account is left behind", async () => {
  const res = await signupPost({ name: "Eve Q", username: "eveq", password: "short" });
  expect(new URL(res.headers.get("location")!, "http://localhost").searchParams.get("err"))
    .toMatch(/at least 10/);
  expect(auth.pendingRequests().some((s) => s.username === "eveq")).toBe(false);
});

test("a configured sign-up code is required, and the wrong one creates nothing", async () => {
  // config is read once at import, so reach into it rather than re-importing.
  const cfg = config as unknown as { signupCode: string };
  cfg.signupCode = "go-hit-2026";
  try {
    const refused = await signupPost({ name: "Mallory X", username: "mallory",
                                       password: "mallory-password-1" });
    expect(new URL(refused.headers.get("location")!, "http://localhost")
      .searchParams.get("err")).toMatch(/sign-up code/);
    expect(auth.pendingRequests().some((s) => s.username === "mallory")).toBe(false);
    expect(refused.headers.get("set-cookie")).toBeNull();

    const accepted = await signupPost({ name: "Mallory X", username: "mallory",
                                        password: "mallory-password-1",
                                        code: "go-hit-2026" });
    expect(new URL(accepted.headers.get("location")!, "http://localhost").pathname)
      .toBe("/signup");
    expect(auth.pendingRequests().some((s) => s.username === "mallory")).toBe(true);
  } finally {
    cfg.signupCode = "";          // the other tests expect open sign-up
  }
});

// --- the approval page ------------------------------------------------------

/**
 * An admin of this block's own.
 *
 * Not helper.ts's shared account: "the last active admin cannot be demoted"
 * above demotes every other admin it finds, and whether that catches the
 * shared one depends on which test file called for it first -- which made
 * these tests pass alone and fail in a full run.
 */
const asAdmin = async () => {
  const username = "approver";
  if (!auth.listStudents().some((s) => s.username === username)) {
    await auth.createStudent("Approver A", username, "approver-password-1", "admin");
  }
  const s = await auth.login(username, "approver-password-1");
  if (!s.ok) throw new Error(`admin sign-in failed: ${s.reason}`);
  return { "content-type": "application/x-www-form-urlencoded",
           origin: "http://localhost",
           cookie: `${auth.SESSION_COOKIE}=${s.token}` };
};

test("the requests page shows who is waiting, and what their emails will say", async () => {
  await signupPost({ name: "Pat Q", username: "patq", password: "patq-password-1" });

  const res = await routes.request("http://localhost/requests", { headers: await asAdmin() });
  expect(res.status).toBe(200);

  const html = await res.text();
  expect(html).toContain("Pat Q");
  expect(html).toContain("patq");
  // The preview is the decision: the signature a sponsor will actually read.
  expect(html).toContain(displayNameFor({ sender_name: null }, "Pat Q"));
});

test("approve and decline work from the page, and are admin-only", async () => {
  const waiting = auth.pendingRequests().find((s) => s.username === "patq")!;

  const res = await routes.request(`http://localhost/requests/${waiting.id}/approve`,
    { method: "POST", headers: await asAdmin() });
  expect(res.status).toBe(302);
  const loc = new URL(res.headers.get("location")!, "http://localhost");
  expect(loc.pathname).toBe("/requests");
  expect(loc.searchParams.get("ok")).toMatch(/Pat Q/);
  expect(auth.getStudent(waiting.id)!.approved_at).not.toBeNull();

  // A student may not approve anyone, and the request survives the attempt.
  await signupPost({ name: "Sam R", username: "samr", password: "samr-password-1" });
  const pending = auth.pendingRequests().find((s) => s.username === "samr")!;
  const studentId = await auth.createStudent("Plain Student", "plainstudent",
                                             "plain-password-1", "student");
  const session = await auth.login("plainstudent", "plain-password-1");
  if (!session.ok) throw new Error("sign-in failed");

  const denied = await routes.request(`http://localhost/requests/${pending.id}/approve`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded",
               origin: "http://localhost",
               cookie: `${auth.SESSION_COOKIE}=${session.token}` },
  });
  expect(new URL(denied.headers.get("location")!, "http://localhost").searchParams.get("err"))
    .toMatch(/admin/);
  expect(auth.getStudent(pending.id)!.approved_at).toBeNull();

  // ...and the page itself sends them away rather than 500ing.
  const page = await routes.request("http://localhost/requests",
    { headers: { cookie: `${auth.SESSION_COOKIE}=${session.token}` } });
  expect(page.status).toBe(302);
  expect(new URL(page.headers.get("location")!, "http://localhost").pathname).toBe("/accounts");

  auth.setActive(studentId, false);          // leave the table as we found it
});

// --- CSRF behind a TLS-terminating proxy ------------------------------------

/** A form POST with no Sec-Fetch-Site, so the Origin check is what decides. */
const postFrom = (origin: string, username: string) =>
  routes.request("http://localhost/signup", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", origin },
    body: new URLSearchParams({ name: "Origin T", username,
                                password: "origint-password" }).toString(),
  });

test("an https Origin on an http request is ours -- that is a proxy, not an attacker", async () => {
  // Render (and any reverse proxy) terminates TLS and forwards plain http, so
  // the browser's Origin says https while the request here says http. Comparing
  // whole origins rejected every form POST on this deployment.
  expect((await postFrom("https://localhost", "proxied")).status).not.toBe(403);
  expect(auth.pendingRequests().some((s) => s.username === "proxied")).toBe(true);
});

test("an Origin on another host is still refused", async () => {
  expect((await postFrom("https://evil.example", "crossorigin")).status).toBe(403);
  expect(auth.pendingRequests().some((s) => s.username === "crossorigin")).toBe(false);
});

// --- the route gate ---------------------------------------------------------

test("every page is behind the gate; only /login and /signup are open", async () => {
  for (const path of ["/", "/campaigns", "/history", "/log", "/suppressions", "/accounts"]) {
    const res = await routes.request("http://localhost" + path);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toStartWith("/login");
  }
  for (const path of ["/login", "/signup"]) {
    const open = await routes.request("http://localhost" + path);
    expect(open.status).toBe(200);
  }
});

test("a signed-in visitor to /signup is sent to the app, not the form", async () => {
  const res = await routes.request("http://localhost/signup",
    { headers: { cookie: await sessionCookie() } });
  expect(res.status).toBe(302);
  expect(res.headers.get("location")).toBe("/");
});

/**
 * The first account is an admin, and /signup never says so -- so with an empty
 * table it hands over to the bootstrap page on /login, which does.
 *
 * This needs a students table with nothing in it, and the whole suite shares
 * one in-memory database (tests/setup.ts), so it runs in its own process.
 */
test("with no accounts at all, /signup defers to the bootstrap page", async () => {
  const root = join(import.meta.dir, "..");
  const proc = Bun.spawn(["bun", "-e", `
    const { routes } = await import(${JSON.stringify(join(root, "src/web/routes.ts"))});
    const signup = await routes.request("http://localhost/signup");
    const login  = await routes.request("http://localhost/login");
    console.log(JSON.stringify({
      status: signup.status,
      to: signup.headers.get("location"),
      bootstrap: (await login.text()).includes("Create the first account"),
    }));
  `], { cwd: root, env: { ...process.env, DB_PATH: ":memory:" }, stdout: "pipe", stderr: "pipe" });

  const out = await new Response(proc.stdout).text();
  expect(await proc.exited).toBe(0);
  expect(JSON.parse(out.trim().split("\n").at(-1)!))
    .toEqual({ status: 302, to: "/login", bootstrap: true });
}, 20_000);

test("the ?next= redirect cannot be pointed at another site", async () => {
  const res = await routes.request("http://localhost//evil.example/path");
  expect(res.headers.get("location")).not.toContain("evil.example");
});

test("a signed-in request reaches the page", async () => {
  const res = await routes.request("http://localhost/", { headers: { cookie: await sessionCookie() } });
  expect(res.status).toBe(200);
});

// --- attribution ------------------------------------------------------------

test("the signed-in student signs the message, over the .env fallback", async () => {
  const id = await auth.createStudent("Bella K", "bella", "bella-password-1");
  const student = auth.getStudent(id)!;
  const company = { sender_name: null } as { sender_name: string | null };
  expect(senderNameFor(company)).toBe(config.canSpam.senderName);
  expect(senderNameFor(company, student.name)).toBe("Bella K");
});

test("a per-company override still outranks the student", () => {
  expect(senderNameFor({ sender_name: "Coach" }, "Bella K")).toBe("Coach");
});

test("queuing records the student and tags the company with their name", async () => {
  setSetting("current_campaign", CAMPAIGN);
  const sid = auth.listStudents().find((s) => s.username === "bella")!.id;

  db.query(`INSERT INTO companies (id, chamber_slug, name, name_key, city, state, review_status, template_id)
            VALUES (800, 'auth-co', 'Auth Co', 'auth co', 'Huntsville', 'AL', 'approved', 1)`).run();
  db.query(`INSERT INTO emails (company_id, address, source, confidence, is_primary, verified)
            VALUES (800, 'hi@auth.example', 'mailto', 1.0, 1, 1)`).run();

  enqueue(800, { id: sid, name: "Bella K" });

  const row = db.query<{ student_id: number; sender_name: string; body: string }, []>(
    `SELECT student_id, sender_name, body FROM sends WHERE company_id = 800`).get()!;
  expect(row.student_id).toBe(sid);
  expect(row.sender_name).toBe("Bella K");     // signed by the sender
  expect(row.body).toContain("Bella K");       // and in the footer

  // The company tag lands when it SENDS, not when it queues.
  expect(repo.tagsFor(800).map((t) => t.name)).not.toContain("Student: Bella K");
});

test("a form contact is attributed and tagged immediately", async () => {
  const sid = auth.listStudents().find((s) => s.username === "bella")!.id;
  db.query(`INSERT INTO companies (id, chamber_slug, name, name_key, review_status, template_id)
            VALUES (801, 'auth-co-2', 'Form Co', 'form co', 'approved', 1)`).run();

  const { recordFormSend } = await import("../src/mail/queue.ts");
  recordFormSend(801, { id: sid, name: "Bella K" });

  const row = db.query<{ student_id: number }, []>(
    `SELECT student_id FROM sends WHERE company_id = 801`).get()!;
  expect(row.student_id).toBe(sid);
  expect(repo.tagsFor(801).map((t) => t.name)).toContain("Student: Bella K");
});

test("an account with sends against it cannot be deleted, only deactivated", () => {
  const sid = auth.listStudents().find((s) => s.username === "bella")!.id;
  expect(() => auth.deleteStudent(sid)).toThrow(/kept for the record/);
  auth.setActive(sid, false);
  expect(auth.getStudent(sid)!.active).toBe(0);
});
