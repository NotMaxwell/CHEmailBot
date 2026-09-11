// Exercises the five gates and the dedup guarantee against an in-memory DB.
// Env is set BEFORE importing config/db so nothing here touches data/chembot.db.
import { expect, test } from "bun:test";

process.env.DB_PATH = ":memory:";
process.env.SENDER_NAME = "Test Sender";
process.env.SENDER_POSTAL_ADDRESS = "1 Test St, Huntsville AL";
process.env.UNSUBSCRIBE_MAILTO = "unsub@test.example";
process.env.DRY_RUN = "1";

const { db } = await import("../src/db.ts");
const { enqueue, blockersFor, capForDay } = await import("../src/mail/queue.ts");

db.query(
  `INSERT INTO companies (id, chamber_slug, name, name_key, website, city, state)
   VALUES (1, 'acme-1', 'Acme Inc', 'acme', 'https://acme.example', 'Huntsville', 'AL')`,
).run();
db.query(
  `INSERT INTO emails (id, company_id, address, source, confidence, is_primary)
   VALUES (1, 1, 'hi@acme.example', 'mailto', 1.0, 1)`,
).run();

test("gates block an unreviewed company and name the missing step", () => {
  const b = blockersFor(1);
  expect(b.join(" ")).toContain("step 2");
  expect(b.join(" ")).toContain("step 3");
  expect(b.join(" ")).toContain("step 4");
});

test("clearing steps 2-4 clears every blocker", () => {
  db.query(`UPDATE companies SET review_status='approved', template_id=1 WHERE id=1`).run();
  db.query(`UPDATE emails SET verified=1 WHERE id=1`).run();
  expect(blockersFor(1)).toEqual([]);
});

test("a suppressed address re-blocks the send", () => {
  db.query(`INSERT INTO suppressions (value, kind) VALUES ('acme.example','domain')`).run();
  expect(blockersFor(1).join(" ")).toContain("suppression");
  db.query(`DELETE FROM suppressions`).run();
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
    db.query(`INSERT INTO sends (company_id, email_address, subject, body)
              VALUES (1, 'other@acme.example', 's', 'b')`).run(),
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
