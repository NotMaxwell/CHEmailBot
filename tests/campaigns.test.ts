// Campaign default templates and the bulk template actions behind the
// Campaigns & templates tab.
import { expect, test } from "bun:test";

process.env.DB_PATH = ":memory:";
process.env.SENDER_NAME = "Test Sender";
process.env.SENDER_POSTAL_ADDRESS = "1 Test St, Huntsville AL";
process.env.UNSUBSCRIBE_MAILTO = "unsub@test.example";
process.env.DRY_RUN = "1";

const { db, setSetting, setCampaignDefaultTemplate, campaignDefaultTemplate } =
  await import("../src/db.ts");
const repo = await import("../src/repo.ts");
const { blockersFor } = await import("../src/mail/queue.ts");
const { routes } = await import("../src/web/routes.ts");

// Own campaign and id range, so the shared in-memory DB can't collide with the
// other suites whichever order they run in.
const CAMPAIGN = "campaign-test";
db.query(`INSERT OR IGNORE INTO campaigns (name) VALUES (?)`).run(CAMPAIGN);
setSetting("current_campaign", CAMPAIGN);

const ALT = repo.createTemplate("Alt outreach", "Alt {{company}}", "Alt body for {{company}}.");

db.query(
  `INSERT INTO companies (id, chamber_slug, name, name_key, website, city, state, review_status)
   VALUES (700, 'camp-co-700', 'Camp Co', 'camp co', 'https://camp.example', 'Huntsville', 'AL', 'approved')`,
).run();
db.query(
  `INSERT INTO emails (company_id, address, source, confidence, is_primary, verified)
   VALUES (700, 'hi@camp.example', 'mailto', 1.0, 1, 1)`,
).run();

const company = () => repo.getCompany(700)!;

// --- template resolution ----------------------------------------------------

test("with no choice and no campaign default, nothing resolves and step 4 blocks", () => {
  setCampaignDefaultTemplate(CAMPAIGN, null);
  db.query(`UPDATE companies SET template_id = NULL WHERE id = 700`).run();
  expect(repo.resolveTemplateFor(company())).toBeNull();
  expect(blockersFor(700).join(" ")).toContain("step 4");
});

test("a campaign default clears the step 4 blocker without touching the company", () => {
  setCampaignDefaultTemplate(CAMPAIGN, ALT);
  const r = repo.resolveTemplateFor(company())!;
  expect(r.source).toBe("campaign");
  expect(r.template.id).toBe(ALT);
  expect(company().template_id).toBeNull();      // inherited, not written through
  expect(blockersFor(700)).toEqual([]);
});

test("a company's own choice outranks the campaign default", () => {
  const own = repo.createTemplate("Own", "Own {{company}}", "Own body.");
  repo.setTemplate(700, own);
  const r = repo.resolveTemplateFor(company())!;
  expect(r.source).toBe("company");
  expect(r.template.id).toBe(own);
});

test("the default survives a campaign switch and is per campaign", () => {
  db.query(`INSERT OR IGNORE INTO campaigns (name) VALUES ('other-camp')`).run();
  setCampaignDefaultTemplate("other-camp", null);
  expect(campaignDefaultTemplate(CAMPAIGN)).toBe(ALT);
  expect(campaignDefaultTemplate("other-camp")).toBeNull();
});

test("setting a default to a template that does not exist is rejected", () => {
  expect(() => setCampaignDefaultTemplate(CAMPAIGN, 999999)).toThrow(/No template/);
});

// --- bulk actions -----------------------------------------------------------

test("apply-to-missing fills only the gaps and skips contacted companies", () => {
  db.query(`INSERT INTO companies (id, chamber_slug, name, name_key, review_status)
            VALUES (701, 'camp-co-701', 'Gap Co', 'gap co', 'approved')`).run();
  db.query(`INSERT INTO companies (id, chamber_slug, name, name_key, review_status)
            VALUES (702, 'camp-co-702', 'Sent Co', 'sent co', 'approved')`).run();
  db.query(`INSERT INTO sends (company_id, email_address, subject, body, campaign, status)
            VALUES (702, 'x@sent.example', 's', 'b', ?, 'sent')`).run(CAMPAIGN);

  const before = repo.getCompany(700)!.template_id;   // has its own choice
  const n = repo.applyTemplateToCompanies(ALT, "missing", CAMPAIGN);

  expect(n).toBeGreaterThanOrEqual(1);
  expect(repo.getCompany(701)!.template_id).toBe(ALT);   // gap filled
  expect(repo.getCompany(700)!.template_id).toBe(before); // own choice untouched
  expect(repo.getCompany(702)!.template_id).toBeNull();   // already contacted
});

test("clearing choices sends everyone back to the campaign default", () => {
  repo.clearCompanyTemplates(CAMPAIGN);
  expect(repo.getCompany(700)!.template_id).toBeNull();
  expect(repo.resolveTemplateFor(repo.getCompany(700)!)!.source).toBe("campaign");
});

// --- the new tab ------------------------------------------------------------

test("the campaigns page renders and lists the current campaign", async () => {
  const res = await routes.request("http://localhost/campaigns");
  expect(res.status).toBe(200);
  const html = await res.text();
  expect(html).toContain(CAMPAIGN);
  expect(html).toContain("Default template");
});

test("the old templates URL redirects to the merged tab", async () => {
  const res = await routes.request("http://localhost/templates");
  expect(res.status).toBe(302);
  expect(res.headers.get("location")).toBe("/campaigns");
});

test("a campaign with sends against it cannot be deleted", () => {
  expect(() => repo.deleteCampaign(CAMPAIGN)).toThrow();
});
