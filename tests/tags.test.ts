// Tags, history, and the campaign-scoped dedup guarantee. In-memory DB.
import { expect, test } from "bun:test";

process.env.DB_PATH = ":memory:";
process.env.SENDER_NAME = "Test Sender";
process.env.SENDER_POSTAL_ADDRESS = "1 Test St, Huntsville AL";
process.env.UNSUBSCRIBE_MAILTO = "unsub@test.example";

const { db, setSetting, currentCampaign, alreadyContacted, priorContact } = await import("../src/db.ts");
const repo = await import("../src/repo.ts");
const { enqueue, recordFormSend } = await import("../src/mail/queue.ts");

// bun test shares one module registry across files, so src/db.ts is a singleton
// and this DB is shared with queue.test.ts. Use our own id and filter history
// assertions to it rather than assuming an empty table.
const CO = 100;
db.query(`INSERT INTO companies (id, chamber_slug, name, name_key, website, city, state, review_status, template_id)
          VALUES (?,'tagco-1','Tagco Inc','tagco','https://tagco.example','Huntsville','AL','approved',1)`).run(CO);
db.query(`INSERT INTO emails (company_id, address, source, confidence, is_primary, verified)
          VALUES (?,'hi@tagco.example','mailto',1.0,1,1)`).run(CO);
const mine = () => repo.listHistory().find((r) => r.id === CO)!;
setSetting("current_campaign", "initial-outreach");   // pin: queue.test.ts sets its own

test("starter tags ship with the schema", () => {
  const names = repo.listTags().map((t) => t.name);
  expect(names).toContain("Partner");
  expect(names).toContain("Repeat donor");
  expect(names).toContain("Send TY letter");
});

test("addTag creates unknown tags and is idempotent", () => {
  repo.addTag(CO, "Sponsor 2027", "label", "committed at the gala");
  repo.addTag(CO, "Sponsor 2027", "label");            // again: must not duplicate
  const mine = repo.tagsFor(CO).filter((t) => t.name === "Sponsor 2027");
  expect(mine).toHaveLength(1);
  expect(mine[0]!.note).toBe("committed at the gala");  // note survives re-add
});

test("reminders toggle done instead of being deleted", () => {
  repo.addTag(CO, "Send TY letter", "reminder");
  const id = repo.listTags().find((t) => t.name === "Send TY letter")!.id;
  expect(repo.tagsFor(CO).find((t) => t.name === "Send TY letter")!.done).toBe(0);
  repo.setTagDone(CO, id, true);
  expect(repo.tagsFor(CO).find((t) => t.name === "Send TY letter")!.done).toBe(1);
});

test("removeTag detaches without destroying the tag itself", () => {
  const id = repo.listTags().find((t) => t.name === "Sponsor 2027")!.id;
  repo.removeTag(CO, id);
  expect(repo.tagsFor(CO).some((t) => t.name === "Sponsor 2027")).toBe(false);
  expect(repo.listTags().some((t) => t.name === "Sponsor 2027")).toBe(true);
});

// --- campaigns --------------------------------------------------------------

test("a send is auto-tagged with its campaign, subject kept in the note", () => {
  expect(currentCampaign()).toBe("initial-outreach");
  recordFormSend(CO);
  const auto = repo.tagsFor(CO).find((t) => t.name === "Messaged: initial-outreach");
  expect(auto).toBeDefined();
  expect(auto!.note).toBe("Quick question about Tagco Inc");   // rendered, not raw
});

test("dedup blocks a second send inside the same campaign", () => {
  expect(alreadyContacted(CO)).toBe(true);
  expect(() => enqueue(CO)).toThrow(/already queued or sent/i);
});

test("switching campaign permits a deliberate re-contact", () => {
  setSetting("current_campaign", "fall-2027-gala");
  expect(alreadyContacted(CO)).toBe(false);          // not in THIS campaign
  expect(priorContact(CO)?.campaign).toBe("initial-outreach");  // but flagged as prior
  expect(() => enqueue(CO)).not.toThrow();
});

test("dedup still blocks a duplicate inside the NEW campaign", () => {
  expect(() => enqueue(CO)).toThrow(/already queued or sent/i);
  expect(() =>
    db.query(`INSERT INTO sends (company_id, email_address, subject, body, campaign)
              VALUES (?,'other@tagco.example','s','b','fall-2027-gala')`).run(CO),
  ).toThrow(/UNIQUE constraint failed/);
});

// --- history ----------------------------------------------------------------

test("history lists the company once, with both campaigns and its tags", () => {
  const row = mine();
  expect(row.name).toBe("Tagco Inc");
  expect(row.campaigns).toContain("initial-outreach");
  expect(row.campaigns).toContain("fall-2027-gala");
  expect(row.send_count).toBe(2);                      // one per campaign, not duplicated
  const tags = repo.unpackTags(row.tags);
  expect(tags.map((t) => t.name)).toContain("Messaged: initial-outreach");
  expect(tags.find((t) => t.name === "Send TY letter")!.kind).toBe("reminder");
});

test("history filters by tag and by campaign", () => {
  const tagId = repo.listTags().find((t) => t.name === "Partner")!.id;
  expect(repo.listHistory(tagId).some((r) => r.id === CO)).toBe(false);
  repo.addTag(CO, "Partner");
  expect(repo.listHistory(tagId).some((r) => r.id === CO)).toBe(true);
  expect(repo.listHistory(undefined, "fall-2027-gala").some((r) => r.id === CO)).toBe(true);
  expect(repo.listHistory(undefined, "no-such-campaign")).toHaveLength(0);
});

test("open reminders are counted for the history banner", () => {
  expect(mine().open_reminders).toBe(0);               // marked done earlier
  repo.addTag(CO, "Call about sponsorship", "reminder");
  expect(mine().open_reminders).toBe(1);
});
