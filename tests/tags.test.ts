// Tags, history, and the campaign-scoped dedup guarantee. In-memory DB.
import { expect, test } from "bun:test";

process.env.DB_PATH = ":memory:";
process.env.SENDER_NAME = "Test Sender";
process.env.SENDER_ORG = "";
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

// --- campaign lifecycle -----------------------------------------------------

test("a created-but-unused campaign still appears in the picker", () => {
  const { switchCampaign } = require("../src/db.ts");
  switchCampaign("spring-2028-appeal");                  // created, nothing sent
  const names = repo.listCampaigns().map((c) => c.campaign);
  expect(names).toContain("spring-2028-appeal");
  expect(repo.listCampaigns().find((c) => c.campaign === "spring-2028-appeal")!.n).toBe(0);
});

test("switching to an existing campaign does not duplicate it", () => {
  const { switchCampaign, currentCampaign } = require("../src/db.ts");
  switchCampaign("spring-2028-appeal");
  const hits = repo.listCampaigns().filter((c) => c.campaign === "spring-2028-appeal");
  expect(hits).toHaveLength(1);
  expect(currentCampaign()).toBe("spring-2028-appeal");
});

test("campaign names are trimmed and cannot be blank", () => {
  const { switchCampaign, currentCampaign } = require("../src/db.ts");
  switchCampaign("  padded-name  ");
  expect(currentCampaign()).toBe("padded-name");
  expect(() => switchCampaign("   ")).toThrow(/cannot be empty/i);
  expect(() => switchCampaign("x".repeat(61))).toThrow(/too long/i);
});

// --- review queue vs. campaign ---------------------------------------------

test("a form contact lands in Contacted, and leaves the ready lists", () => {
  const { switchCampaign } = require("../src/db.ts");
  switchCampaign("queue-view-test");
  db.query(`INSERT INTO companies (id, chamber_slug, name, name_key, website, review_status, template_id)
            VALUES (200,'formco','Formco','formco','https://formco.example','approved',1)`).run();
  db.query(`INSERT INTO emails (company_id,address,source,confidence,is_primary,verified)
            VALUES (200,'a@formco.example','mailto',1.0,1,1)`).run();

  const inFilter = (f: string) => repo.listCompanies(f).some((r) => r.id === 200);
  expect(inFilter("ready")).toBe(true);            // verified address, not contacted
  expect(inFilter("contacted")).toBe(false);

  recordFormSend(200);
  expect(inFilter("contacted")).toBe(true);        // form contact counts as contacted
  expect(inFilter("ready")).toBe(false);           // and drops out of ready
  expect(repo.listCompanies("contacted").find((r) => r.id === 200)!.send_channel).toBe("form");
});

test("contacted status is per-campaign, so a new campaign re-opens the company", () => {
  const { switchCampaign } = require("../src/db.ts");
  switchCampaign("queue-view-test-2");
  expect(repo.listCompanies("contacted").some((r) => r.id === 200)).toBe(false);
  expect(repo.listCompanies("ready").some((r) => r.id === 200)).toBe(true);
});

test("companies with no usable address show up under form assist", () => {
  const { switchCampaign } = require("../src/db.ts");
  switchCampaign("form-filter-test");
  db.query(`INSERT INTO companies (id, chamber_slug, name, name_key, website, review_status)
            VALUES (201,'noaddr','NoAddr Inc','noaddr','https://noaddr.example','approved')`).run();
  const formList = repo.listCompanies("form");
  expect(formList.some((r) => r.id === 201)).toBe(true);   // no email at all
  expect(formList.some((r) => r.id === 200)).toBe(false);  // has a verified address
  expect(repo.listCompanies("ready").some((r) => r.id === 201)).toBe(false);
});
