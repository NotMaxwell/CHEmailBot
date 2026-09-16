// Accounts, sessions, the route gate, and send attribution.
import { expect, test } from "bun:test";

process.env.DB_PATH = ":memory:";
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

test("a correct password opens a session and a wrong one does not", async () => {
  expect(await auth.login("alice", "wrong-password-x")).toBeNull();
  const s = await auth.login("alice", "alice-password-1");
  expect(s).not.toBeNull();
  expect(auth.studentForToken(s!.token)?.username).toBe("alice");
});

test("an unknown username is refused without saying so", async () => {
  expect(await auth.login("nobody", "alice-password-1")).toBeNull();
});

test("signing out invalidates that token immediately", async () => {
  const s = (await auth.login("alice", "alice-password-1"))!;
  auth.logout(s.token);
  expect(auth.studentForToken(s.token)).toBeNull();
});

test("changing a password ends every existing session", async () => {
  const a = (await auth.login("alice", "alice-password-1"))!;
  const b = (await auth.login("alice", "alice-password-1"))!;
  await auth.setPassword(auth.studentForToken(a.token)!.id, "alice-password-2");
  expect(auth.studentForToken(a.token)).toBeNull();
  expect(auth.studentForToken(b.token)).toBeNull();
  expect(await auth.login("alice", "alice-password-2")).not.toBeNull();
});

test("deactivating an account kills its sessions and blocks sign-in", async () => {
  const s = (await auth.login("alice", "alice-password-2"))!;
  const id = auth.studentForToken(s.token)!.id;
  auth.setActive(id, false);
  expect(auth.studentForToken(s.token)).toBeNull();
  expect(await auth.login("alice", "alice-password-2")).toBeNull();
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

// --- the route gate ---------------------------------------------------------

test("every page is behind the gate; only /login is open", async () => {
  for (const path of ["/", "/campaigns", "/history", "/log", "/suppressions", "/accounts"]) {
    const res = await routes.request("http://localhost" + path);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toStartWith("/login");
  }
  const open = await routes.request("http://localhost/login");
  expect(open.status).toBe(200);
});

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
