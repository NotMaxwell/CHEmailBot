// Exercises the five gates and the dedup guarantee against an in-memory DB.
// Env is set BEFORE importing config/db so nothing here touches data/chembot.db.
import { expect, test } from "bun:test";

process.env.DB_PATH = ":memory:";
process.env.SENDER_NAME = "Test Sender";
process.env.SENDER_ORG = "";
process.env.SENDER_POSTAL_ADDRESS = "1 Test St, Huntsville AL";
process.env.UNSUBSCRIBE_MAILTO = "unsub@test.example";
process.env.DRY_RUN = "1";

const { db, setSetting } = await import("../src/db.ts");
const { enqueue, blockersFor, capForDay, cancelQueued } =
  await import("../src/mail/queue.ts");
const repo = await import("../src/repo.ts");

// bun test shares one module registry, so src/db.ts is a singleton and this DB
// is shared with tags.test.ts. Pin our own campaign and ids so the two suites
// cannot disturb each other whichever order they run in.
const CAMPAIGN = "queue-test";
setSetting("current_campaign", CAMPAIGN);

db.query(
  `INSERT INTO companies (id, chamber_slug, name, name_key, website, city, state)
   VALUES (1, 'acme-1', 'Acme Inc', 'acme', 'https://acme.example', 'Huntsville', 'AL')`,
).run();
db.query(
  `INSERT INTO emails (company_id, address, source, confidence, is_primary)
   VALUES (1, 'hi@acme.example', 'mailto', 1.0, 1)`,
).run();

test("gates block an unreviewed company and name the missing step", () => {
  const b = blockersFor(1);
  expect(b.join(" ")).toContain("step 2");
  expect(b.join(" ")).toContain("step 3");
  expect(b.join(" ")).toContain("step 4");
});

test("clearing steps 2-4 clears every blocker", () => {
  db.query(`UPDATE companies SET review_status='approved', template_id=1 WHERE id=1`).run();
  db.query(`UPDATE emails SET verified=1 WHERE company_id=1`).run();
  expect(blockersFor(1)).toEqual([]);
});

test("a suppressed domain re-blocks the send", () => {
  db.query(`INSERT INTO suppressions (value, kind) VALUES ('acme.example','domain')`).run();
  try {
    expect(blockersFor(1).join(" ")).toContain("do-not-contact");
  } finally {
    // Cleanup must run even if the assertion fails, or the leftover suppression
    // blocks every later test in this file and hides the one real failure.
    db.query(`DELETE FROM suppressions`).run();
  }
  expect(blockersFor(1)).toEqual([]);
});

test("enqueue stores the fully rendered copy, not the template", () => {
  enqueue(1);
  const row = db.query<{ subject: string; body: string; status: string }, []>(
    `SELECT subject, body, status FROM sends WHERE company_id=1`).get()!;
  expect(row.status).toBe("queued");
  expect(row.subject).toBe("Quick question about Acme Inc");
  expect(row.body).not.toContain("{{");                    // no unresolved merge fields
  expect(row.body).toContain("1 Test St, Huntsville AL");  // CAN-SPAM footer present
});

// THE GUARANTEE. Both layers must refuse.
test("a second send is refused by the app layer", () => {
  expect(() => enqueue(1)).toThrow(/already queued or sent/i);
});

test("a second send is refused by SQLite even if app logic is bypassed", () => {
  expect(() =>
    db.query(`INSERT INTO sends (company_id, email_address, subject, body, campaign)
              VALUES (1, 'other@acme.example', 's', 'b', ?)`).run(CAMPAIGN),
  ).toThrow(/UNIQUE constraint failed/);
});

test("a failed send falls out of the index so a retry is still allowed", () => {
  db.query(`UPDATE sends SET status='failed' WHERE company_id=1`).run();
  expect(() => enqueue(1)).not.toThrow();
});

test("the warm-up ramp clamps to its last value", () => {
  expect(capForDay(0)).toBe(5);
  expect(capForDay(999)).toBe(50);
});

// --- taking things back out -------------------------------------------------
//
// Own id range: company 1 above is left mid-workflow by the tests before this,
// and the shared in-memory DB means disturbing it would break them by order.

/** A company cleared through every gate, queued, and ready to be cancelled. */
function queuedCompany(id: number): void {
  db.query(
    `INSERT INTO companies (id, chamber_slug, name, name_key, website, city, state,
                            review_status, template_id)
     VALUES (?, ?, ?, ?, 'https://cancel.example', 'Huntsville', 'AL', 'approved', 1)`,
  ).run(id, `cancel-co-${id}`, `Cancel Co ${id}`, `cancel co ${id}`);
  db.query(
    `INSERT INTO emails (company_id, address, source, confidence, is_primary, verified)
     VALUES (?, ?, 'mailto', 1.0, 1, 1)`,
  ).run(id, `hi@cancel${id}.example`);
  enqueue(id);
}

const liveSends = (id: number) =>
  db.query<{ n: number }, [number]>(
    `SELECT COUNT(*) n FROM sends WHERE company_id = ? AND status = 'queued'`,
  ).get(id)!.n;

test("cancelling a queued send frees the company to be queued again", () => {
  queuedCompany(1100);
  expect(liveSends(1100)).toBe(1);

  cancelQueued(1100);
  expect(liveSends(1100)).toBe(0);
  expect(blockersFor(1100)).toEqual([]);      // no longer "already queued or sent"
  expect(() => enqueue(1100)).not.toThrow();  // and the dedup index agrees
});

test("cancelling refuses a send a drain has already claimed", () => {
  queuedCompany(1101);
  db.query(`UPDATE sends SET attempted_at = datetime('now') WHERE company_id = 1101`).run();

  expect(() => cancelQueued(1101)).toThrow(/already in flight/i);
  expect(liveSends(1101)).toBe(1);            // the only trace of it is still there
});

test("cancelling says so when there is nothing queued", () => {
  expect(() => cancelQueued(1102)).toThrow(/nothing is queued/i);
});

test("deleting a company takes its addresses and pending send with it", () => {
  queuedCompany(1103);
  repo.deleteCompany(1103);

  expect(repo.getCompany(1103)).toBeNull();
  expect(liveSends(1103)).toBe(0);            // cascade, not an orphan
  expect(db.query<{ n: number }, [number]>(
    `SELECT COUNT(*) n FROM emails WHERE company_id = ?`).get(1103)!.n).toBe(0);
});

test("deleting a contacted company is refused so the send log survives", () => {
  queuedCompany(1104);
  db.query(`UPDATE sends SET status='sent', sent_at=datetime('now') WHERE company_id=1104`).run();

  expect(() => repo.deleteCompany(1104)).toThrow(/kept for the record/i);
  expect(repo.getCompany(1104)).not.toBeNull();
  expect(db.query<{ n: number }, [number]>(
    `SELECT COUNT(*) n FROM sends WHERE company_id = ? AND status='sent'`).get(1104)!.n).toBe(1);
});

test("a send claimed mid-drain also blocks the delete -- it may have gone out", () => {
  queuedCompany(1105);
  db.query(`UPDATE sends SET attempted_at = datetime('now') WHERE company_id = 1105`).run();

  expect(() => repo.deleteCompany(1105)).toThrow(/kept for the record/i);
});

test("deleting a company that does not exist says so", () => {
  expect(() => repo.deleteCompany(1106)).toThrow(/not found/i);
});
