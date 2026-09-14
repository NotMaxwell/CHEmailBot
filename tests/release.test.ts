// Regression tests for the bugs fixed in the 1.0 audit. Each test names the
// failure it guards against. In-memory DB (tests/setup.ts); ids 900+ and the
// "release-" prefix keep this suite clear of the others sharing that DB.
import { expect, test } from "bun:test";
import { isAbsolute } from "node:path";
import { normalizeWebsite, hostOf } from "../src/url.ts";
import { harvestEmails } from "../src/scrape/parse.ts";

const { db, companySuppression } = await import("../src/db.ts");
const { config, ROOT } = await import("../src/config.ts");
const repo = await import("../src/repo.ts");
const { peekBudget, recoverInterrupted, recordFormSend, blockersFor } =
  await import("../src/mail/queue.ts");
const { routes } = await import("../src/web/routes.ts");

const company = (id: number, name: string, website: string | null, extra = "") =>
  db.query(`INSERT INTO companies (id, chamber_slug, name, name_key, website, review_status${extra ? ", template_id" : ""})
            VALUES (?, ?, ?, ?, ?, 'approved'${extra ? ", 1" : ""})`)
    .run(id, `release-${id}`, name, `release${id}`, website);

// --- URLs -------------------------------------------------------------------

test("websites get a scheme, and only http(s) survives", () => {
  expect(normalizeWebsite("www.acme.com")).toBe("https://www.acme.com/");
  expect(normalizeWebsite("javascript:alert(1)")).toBeNull();   // escaping does not stop this
  expect(normalizeWebsite("ftp://files.acme.com")).toBeNull();
  expect(normalizeWebsite("  ")).toBeNull();
});

test("hostOf never throws -- one bad URL used to 500 the whole queue page", () => {
  expect(hostOf("not a url")).toBeNull();
  expect(hostOf(null)).toBeNull();
  expect(hostOf("https://WWW.Acme.com/about")).toBe("acme.com");
});

test("mailto links in single quotes and percent-encoded form are harvested", () => {
  const found = harvestEmails(`<a href='mailto:a@acme.com'>x</a><a href="mailto:b%40acme.com">y</a>`, "acme.com");
  expect(found.map((f) => f.address).sort()).toEqual(["a@acme.com", "b@acme.com"]);
});

// --- config -----------------------------------------------------------------

test("the Gmail token path is anchored to the project, not the working directory", () => {
  expect(isAbsolute(config.gmail.tokenPath)).toBe(true);
  expect(config.gmail.tokenPath.startsWith(ROOT)).toBe(true);
});

test("the server binds to loopback by default", () => {
  expect(config.host).toBe("127.0.0.1");
});

// --- addresses --------------------------------------------------------------

test("a manually added address is verified AND becomes the one used", () => {
  company(900, "Release Manual", "https://manual.example", "tpl");
  repo.addManualEmail(900, "Person@Manual.example");
  const [e] = repo.emailsFor(900);
  expect(e).toMatchObject({ address: "person@manual.example", is_primary: 1, verified: 1 });
  expect(blockersFor(900).join(" ")).not.toMatch(/step 3|step 5/);
});

test("adding an already-discovered address upgrades it instead of being ignored", () => {
  company(901, "Release Upgrade", "https://upgrade.example");
  db.query(`INSERT INTO emails (company_id, address, source, confidence, is_primary)
            VALUES (901, 'hi@upgrade.example', 'contact_page', 0.6, 0)`).run();
  repo.addManualEmail(901, "hi@upgrade.example");
  expect(repo.emailsFor(901)[0]).toMatchObject({ verified: 1, is_primary: 1 });
  expect(() => repo.addManualEmail(901, "not-an-address")).toThrow(/not a valid email/);
});

test("setPrimary refuses another company's address and leaves the primary intact", () => {
  company(902, "Release A", null);
  company(903, "Release B", null);
  db.query(`INSERT INTO emails (company_id, address, source, is_primary) VALUES (902, 'a@a.example', 'manual', 1)`).run();
  db.query(`INSERT INTO emails (company_id, address, source, is_primary) VALUES (903, 'b@b.example', 'manual', 1)`).run();
  const foreign = repo.emailsFor(903)[0]!.id;
  expect(() => repo.setPrimary(902, foreign)).toThrow(/does not belong/);
  expect(repo.emailsFor(902).filter((e) => e.is_primary)).toHaveLength(1);   // was wiped to 0
});

// --- do not contact ---------------------------------------------------------

test("an opt-out on the domain blocks form contacts, which have no address", () => {
  company(904, "Release Blocked", "https://www.blocked-release.example");
  repo.addSuppression("https://www.blocked-release.example/contact", "asked us to stop");
  expect(companySuppression(904)).toMatch(/do-not-contact/);
  expect(() => recordFormSend(904)).toThrow(/do-not-contact/);
  expect(repo.listCompanies("form").some((r) => r.id === 904)).toBe(false);
});

test("'Do not contact' on a company records its domain", () => {
  company(905, "Release DNC", "https://dnc-release.example");
  repo.suppressCompany(905, "phoned in");
  expect(repo.listSuppressions().some((s) => s.value === "dnc-release.example" && s.kind === "domain")).toBe(true);
});

// --- sending safety ---------------------------------------------------------

test("a row claimed by a drain that died is failed, never re-sent", () => {
  company(906, "Release Stale", null);
  company(907, "Release Live", null);
  db.query(`INSERT INTO sends (company_id, email_address, subject, body, campaign, attempted_at)
            VALUES (906, 'x@stale.example', 's', 'b', 'release-test', datetime('now','-20 minutes'))`).run();
  db.query(`INSERT INTO sends (company_id, email_address, subject, body, campaign, attempted_at)
            VALUES (907, 'x@live.example', 's', 'b', 'release-test', datetime('now'))`).run();
  recoverInterrupted();
  const status = (id: number) => db.query<{ status: string; error: string | null }, [number]>(
    `SELECT status, error FROM sends WHERE company_id = ?`).get(id)!;
  expect(status(906)).toMatchObject({ status: "failed" });
  expect(status(906).error).toMatch(/Interrupted mid-send/);
  expect(status(907).status).toBe("queued");      // a drain still in flight is left alone
});

test("the warm-up day index counts only days that actually sent", () => {
  db.query(`DELETE FROM send_budget`).run();
  db.query(`INSERT INTO send_budget (day, cap, used) VALUES ('2000-01-01', 5, 0), ('2000-01-02', 5, 0)`).run();
  expect(peekBudget().cap).toBe(config.send.ramp[0]!);          // two idle days: still day one
  db.query(`INSERT INTO send_budget (day, cap, used) VALUES ('2000-01-03', 5, 3)`).run();
  expect(peekBudget().cap).toBe(config.send.ramp[1]!);          // one real sending day
  db.query(`DELETE FROM send_budget`).run();
});

// --- templates --------------------------------------------------------------

test("a template with a mistyped merge field is rejected at save time", () => {
  expect(() => repo.createTemplate("release-typo", "Hi {{compnay}}", "Body")).toThrow(/Unknown merge field/);
});

test("a template on a logged message cannot be deleted", () => {
  const id = repo.createTemplate("release-used", "Hi {{company}}", "Body for {{company}}");
  company(908, "Release Tpl", null);
  db.query(`INSERT INTO sends (company_id, email_address, template_id, subject, body, campaign, status)
            VALUES (908, 'x@tpl.example', ?, 's', 'b', 'release-tpl', 'failed')`).run(id);
  expect(() => repo.deleteTemplate(id)).toThrow(/kept for the record/);
});

// --- categories -------------------------------------------------------------

test("a company listed under two categories keeps both", () => {
  const base = { chamber_slug: "release-multi", name: "Release Multi Cat", website: "multi.example",
    phone: null, street: null, city: null, state: null, postal_code: null, linkedin: null };
  repo.upsertCompany({ ...base, category: "cat-one" });
  repo.upsertCompany({ ...base, category: "cat-two" });
  const row = db.query<{ id: number; website: string }, []>(
    `SELECT id, website FROM companies WHERE chamber_slug = 'release-multi'`).get()!;
  expect(row.website).toBe("https://multi.example/");
  const cats = db.query<{ category: string }, [number]>(
    `SELECT category FROM company_categories WHERE company_id = ? ORDER BY category`).all(row.id);
  expect(cats.map((c) => c.category)).toEqual(["cat-one", "cat-two"]);
});

// --- HTTP -------------------------------------------------------------------

const form = { "content-type": "application/x-www-form-urlencoded" };

test("viewing the dashboard writes no budget row", async () => {
  const before = db.query<{ n: number }, []>(`SELECT COUNT(*) n FROM send_budget`).get()!.n;
  const res = await routes.request("http://localhost/");
  expect(res.status).toBe(200);
  expect(db.query<{ n: number }, []>(`SELECT COUNT(*) n FROM send_budget`).get()!.n).toBe(before);
});

test("a form post from another origin is rejected (CSRF)", async () => {
  const res = await routes.request("http://localhost/company/999999/review", {
    method: "POST", headers: { ...form, origin: "https://evil.example" }, body: "status=approved",
  });
  expect(res.status).toBe(403);
});

test("a form post from the app's own origin is accepted", async () => {
  const res = await routes.request("http://localhost/company/999999/review", {
    method: "POST", headers: { ...form, origin: "http://localhost" }, body: "status=approved",
  });
  expect(res.status).toBe(302);
});

test("pages refuse to be framed by other sites", async () => {
  const res = await routes.request("http://localhost/templates");
  expect(res.headers.get("x-frame-options")).toBeTruthy();
});
