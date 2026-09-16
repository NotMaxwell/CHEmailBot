// Every query the UI needs, in one place. Routes stay thin.
import { db, nameKey, isSuppressed, currentCampaign, companySuppression,
         campaignDefaultTemplate, setCampaignDefaultTemplate } from "./db.ts";
import type { Company, EmailCandidate, MergeContext } from "./types.ts";
import { normalizeWebsite, hostOf } from "./url.ts";
import { render } from "./mail/render.ts";

export interface CompanyRow extends Company {
  email_count: number;
  primary_address: string | null;
  primary_verified: number | null;
  send_status: string | null;
  sent_at: string | null;
  send_channel: string | null;
  template_name: string | null;
  /** Every Chamber category the company is listed under, comma-joined. */
  categories: string | null;
}

export interface CampaignRow {
  campaign: string;
  /** Live contacts: queued + sent. This is what dedup counts. */
  n: number;
  sent: number;
  queued: number;
  last: string | null;
  created_at: string;
  default_template_id: number | null;
  default_template_name: string | null;
}

/**
 * The review-queue list, with everything a row needs to render.
 *
 * The `sends` join is scoped to the CURRENT CAMPAIGN. Without that, a company
 * contacted in a past campaign would read as "contacted" forever and never
 * return to the ready list -- which would defeat the point of campaigns.
 */
export function listCompanies(filter = "all", campaign = currentCampaign()): CompanyRow[] {
  const where =
    // ready to EMAIL: approved, an address verified, not yet contacted this campaign
    filter === "ready"      ? `WHERE c.review_status='approved' AND e.verified=1 AND s.id IS NULL`
    // ready for FORM ASSIST: approved and has a site, but no usable address
    : filter === "form"     ? `WHERE c.review_status='approved' AND c.website IS NOT NULL
                                 AND COALESCE(e.verified,0)=0 AND s.id IS NULL`
    : filter === "contacted" ? `WHERE s.id IS NOT NULL`
    : filter === "new"       ? `WHERE c.review_status='new'`
    : "";
  const rows = db.query<CompanyRow, [string]>(`
    SELECT c.*,
           (SELECT COUNT(*) FROM emails WHERE company_id=c.id) AS email_count,
           e.address  AS primary_address,
           e.verified AS primary_verified,
           s.status   AS send_status,
           s.sent_at  AS sent_at,
           s.channel  AS send_channel,
           t.name     AS template_name,
           (SELECT GROUP_CONCAT(category, ', ') FROM company_categories
             WHERE company_id = c.id) AS categories
    FROM companies c
    LEFT JOIN emails e   ON e.company_id=c.id AND e.is_primary=1
    LEFT JOIN sends  s   ON s.company_id=c.id AND s.status IN ('queued','sent')
                        AND s.campaign = ?
    LEFT JOIN templates t ON t.id=c.template_id
    ${where}
    ORDER BY c.name COLLATE NOCASE
  `).all(campaign);
  // The actionable lists must not offer a company that asked not to be contacted.
  return filter === "ready" || filter === "form"
    ? rows.filter((r) => !companySuppression(r.id))
    : rows;
}

export const getCompany = (id: number) =>
  db.query<Company, [number]>(`SELECT * FROM companies WHERE id=?`).get(id);

export const emailsFor = (id: number) =>
  db.query<EmailCandidate, [number]>(
    `SELECT * FROM emails WHERE company_id=? ORDER BY is_primary DESC, confidence DESC`,
  ).all(id);

export interface Template {
  id: number; name: string; subject: string; body: string;
  /** 1 = append the organisation footer to this template's messages. */
  include_footer: 0 | 1;
}

export const listTemplates = () =>
  db.query<Template, []>(`SELECT * FROM templates ORDER BY name`).all();

export const getTemplate = (id: number) =>
  db.query<Template, [number]>(`SELECT * FROM templates WHERE id=?`).get(id);

export interface TemplateRow extends Template {
  /** Companies that picked this one explicitly (step 4). */
  companies: number;
  /** Messages already queued or sent with it, across all campaigns. */
  messages: number;
  /** Campaigns using it as their fallback, comma-joined. */
  default_for: string | null;
}

/** listTemplates plus the usage figures that make "which of these is doing the
 *  work?" answerable without opening each one. */
export const listTemplatesWithUsage = (): TemplateRow[] =>
  db.query<TemplateRow, []>(`
    SELECT t.*,
           (SELECT COUNT(*) FROM companies c WHERE c.template_id = t.id) AS companies,
           (SELECT COUNT(*) FROM sends s WHERE s.template_id = t.id) AS messages,
           (SELECT GROUP_CONCAT(c.name, ', ') FROM campaigns c
             WHERE c.default_template_id = t.id) AS default_for
    FROM templates t ORDER BY t.name COLLATE NOCASE`).all();

/** How many live companies have their own template vs. none at all. Drives the
 *  "N companies are inheriting it" line on the campaign tab. */
export function templateAssignmentCounts(): { with: number; without: number } {
  const r = db.query<{ w: number; wo: number }, []>(`
    SELECT SUM(CASE WHEN template_id IS NOT NULL THEN 1 ELSE 0 END) AS w,
           SUM(CASE WHEN template_id IS NULL     THEN 1 ELSE 0 END) AS wo
    FROM companies WHERE review_status <> 'rejected'`).get();
  return { with: r?.w ?? 0, without: r?.wo ?? 0 };
}

export type TemplateSource = "company" | "campaign";

/**
 * Which template a company will actually send with, and why.
 *
 * A company's own choice wins; otherwise it inherits the current campaign's
 * default. Returning the SOURCE rather than just the template is what lets the
 * UI say "inherited from campaign X" instead of silently showing a template the
 * user never picked for this company.
 */
export function resolveTemplateFor(
  company: Pick<Company, "template_id">, campaign = currentCampaign(),
): { template: Template; source: TemplateSource } | null {
  if (company.template_id) {
    const own = getTemplate(company.template_id);
    if (own) return { template: own, source: "company" };
  }
  const fallbackId = campaignDefaultTemplate(campaign);
  if (!fallbackId) return null;
  const fallback = getTemplate(fallbackId);
  return fallback ? { template: fallback, source: "campaign" } : null;
}

/**
 * Bulk step 4. "missing" only fills the gaps, which is the safe default;
 * "all" overwrites choices already made, so the UI confirms before calling it.
 * Companies already contacted in this campaign are skipped either way -- their
 * copy is frozen on the send row and re-pointing them changes nothing.
 */
export function applyTemplateToCompanies(
  templateId: number, scope: "missing" | "all", campaign = currentCampaign(),
): number {
  if (!getTemplate(templateId)) throw new Error(`No template with id ${templateId}.`);
  const res = db.query(`
    UPDATE companies SET template_id = ?
     WHERE review_status <> 'rejected'
       ${scope === "missing" ? "AND template_id IS NULL" : ""}
       AND id NOT IN (SELECT company_id FROM sends
                       WHERE campaign = ? AND status IN ('queued','sent'))`)
    .run(templateId, campaign);
  return Number(res.changes);
}

/** Clears every company's explicit choice, so they fall back to the campaign
 *  default. The undo for an "apply to all" you regret. */
export function clearCompanyTemplates(campaign = currentCampaign()): number {
  const res = db.query(`
    UPDATE companies SET template_id = NULL
     WHERE template_id IS NOT NULL
       AND id NOT IN (SELECT company_id FROM sends
                       WHERE campaign = ? AND status IN ('queued','sent'))`).run(campaign);
  return Number(res.changes);
}

// --- the five workflow actions ---------------------------------------------

/** Step 2: verify (or reject) the company as an outreach target. */
export function setReview(id: number, status: "new" | "approved" | "rejected") {
  db.query(`UPDATE companies SET review_status=? WHERE id=?`).run(status, id);
}

/** Step 3: mark a discovered address as human-confirmed. */
export function setVerified(emailId: number, verified: boolean) {
  db.query(`UPDATE emails SET verified=? WHERE id=?`).run(verified ? 1 : 0, emailId);
}

/** Step 5: choose which of several candidate addresses the send will use.
 *  Refuses an address from another company: the old version cleared this
 *  company's primary first and then matched nothing, leaving it with none. */
export function setPrimary(companyId: number, emailId: number) {
  const owned = db.query<{ id: number }, [number, number]>(
    `SELECT id FROM emails WHERE id = ? AND company_id = ?`).get(emailId, companyId);
  if (!owned) throw new Error("That address does not belong to this company.");
  db.transaction(() => {
    db.query(`UPDATE emails SET is_primary=0 WHERE company_id=?`).run(companyId);
    db.query(`UPDATE emails SET is_primary=1 WHERE id=? AND company_id=?`)
      .run(emailId, companyId);
  })();
}

/** Step 4: choose the template for this company. */
/**
 * Who signs this company's message. Empty clears the override, so the company
 * goes back to SENDER_NAME from .env rather than being signed by nobody.
 */
export function setSenderName(companyId: number, name: string): void {
  const clean = name.trim();
  if (clean.length > 80) throw new Error("Sender name is too long (80 characters max).");
  db.query(`UPDATE companies SET sender_name = ? WHERE id = ?`).run(clean || null, companyId);
}

export function setTemplate(companyId: number, templateId: number) {
  db.query(`UPDATE companies SET template_id=? WHERE id=?`).run(templateId, companyId);
}

/**
 * An address typed in by a person is a deliberate choice: store it verified
 * AND make it the one the send uses. It used to be stored but never selected,
 * so a company with no discovered address stayed blocked at step 5 even after
 * you entered one. An address that already existed is upgraded, not ignored.
 */
export function addManualEmail(companyId: number, address: string) {
  const clean = address.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(clean)) {
    throw new Error(`"${address.trim()}" is not a valid email address.`);
  }
  db.transaction(() => {
    db.query(
      `INSERT INTO emails (company_id, address, source, confidence, verified)
       VALUES (?, ?, 'manual', 1.0, 1)
       ON CONFLICT(company_id, address) DO UPDATE SET verified = 1`,
    ).run(companyId, clean);
    db.query(`UPDATE emails SET is_primary = 0 WHERE company_id = ?`).run(companyId);
    db.query(`UPDATE emails SET is_primary = 1 WHERE company_id = ? AND address = ?`)
      .run(companyId, clean);
  })();
}

/** Called after a discovery crawl that reached the site, hits or not. */
export function markEmailsChecked(companyId: number) {
  db.query(`UPDATE companies SET emails_checked_at = datetime('now') WHERE id = ?`).run(companyId);
}

export function upsertCompany(m: {
  chamber_slug: string; name: string; website: string | null; phone: string | null;
  street: string | null; city: string | null; state: string | null;
  postal_code: string | null; linkedin: string | null; category: string;
}): "inserted" | "updated" | "duplicate" {
  const key = nameKey(m.name);
  const website = normalizeWebsite(m.website);     // adds https://, drops javascript: etc.
  const tagCategory = (companyId: number | bigint) =>
    db.query(`INSERT OR IGNORE INTO company_categories (company_id, category) VALUES (?, ?)`)
      .run(companyId, m.category);

  const clash = db.query<{ id: number; chamber_slug: string }, [string]>(
    `SELECT id, chamber_slug FROM companies WHERE name_key=?`,
  ).get(key);
  if (clash && clash.chamber_slug !== m.chamber_slug) {
    tagCategory(clash.id);          // same company under another listing: keep the category
    return "duplicate";
  }

  const existing = db.query<{ id: number }, [string]>(
    `SELECT id FROM companies WHERE chamber_slug=?`,
  ).get(m.chamber_slug);

  if (existing) {
    db.query(
      `UPDATE companies SET name=?,website=?,phone=?,street=?,city=?,state=?,
       postal_code=?,linkedin=?,category=? WHERE id=?`,
    ).run(m.name, website, m.phone, m.street, m.city, m.state,
          m.postal_code, m.linkedin, m.category, existing.id);
    tagCategory(existing.id);
    return "updated";
  }
  const inserted = db.query(
    `INSERT INTO companies (chamber_slug,name,name_key,website,phone,street,city,
     state,postal_code,linkedin,category) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(m.chamber_slug, m.name, key, website, m.phone, m.street, m.city,
        m.state, m.postal_code, m.linkedin, m.category);
  tagCategory(inserted.lastInsertRowid);
  return "inserted";
}

/** Records discovered addresses; first one found becomes primary by default. */
export function recordEmails(
  companyId: number,
  found: { address: string; source: string; confidence: number }[],
) {
  const hasPrimary = db.query<{ n: number }, [number]>(
    `SELECT COUNT(*) n FROM emails WHERE company_id=? AND is_primary=1`,
  ).get(companyId)?.n;
  let primaryAssigned = (hasPrimary ?? 0) > 0;

  for (const f of found) {
    if (isSuppressed(f.address)) continue;
    db.query(
      `INSERT OR IGNORE INTO emails (company_id,address,source,confidence,is_primary)
       VALUES (?,?,?,?,?)`,
    ).run(companyId, f.address, f.source, f.confidence, primaryAssigned ? 0 : 1);
    primaryAssigned = true;
  }
}

/** Counts for the dashboard strip. */
export function stats() {
  const one = (sql: string, ...params: string[]) =>
    db.query<{ n: number }, string[]>(sql).get(...params)?.n ?? 0;
  return {
    companies: one(`SELECT COUNT(*) n FROM companies`),
    approved:  one(`SELECT COUNT(*) n FROM companies WHERE review_status='approved'`),
    withEmail: one(`SELECT COUNT(DISTINCT company_id) n FROM emails`),
    verified:  one(`SELECT COUNT(DISTINCT company_id) n FROM emails WHERE verified=1`),
    // Sent is per campaign, like every other contacted view.
    sent:      one(`SELECT COUNT(*) n FROM sends WHERE status='sent' AND campaign=?`, currentCampaign()),
    // Queued is global on purpose: a drain sends every campaign's queued rows.
    queued:    one(`SELECT COUNT(*) n FROM sends WHERE status='queued'`),
  };
}

// --- tags -------------------------------------------------------------------

export interface Tag { id: number; name: string; kind: "label" | "reminder" }
export interface CompanyTag extends Tag { note: string | null; done: 0 | 1; added_at: string }

export const listTags = () =>
  db.query<Tag & { uses: number }, []>(`
    SELECT t.*, (SELECT COUNT(*) FROM company_tags ct WHERE ct.tag_id = t.id) AS uses
    FROM tags t ORDER BY t.kind DESC, t.name COLLATE NOCASE`).all();

export const tagsFor = (companyId: number) =>
  db.query<CompanyTag, [number]>(`
    SELECT t.id, t.name, t.kind, ct.note, ct.done, ct.added_at
    FROM company_tags ct JOIN tags t ON t.id = ct.tag_id
    WHERE ct.company_id = ?
    ORDER BY t.kind DESC, t.name COLLATE NOCASE`).all(companyId);

/** Creates the tag if it does not exist, then attaches it. Idempotent. */
export function addTag(
  companyId: number, name: string, kind: "label" | "reminder" = "label", note?: string,
): void {
  const clean = name.trim();
  if (!clean) throw new Error("Tag name cannot be empty.");
  db.query(`INSERT OR IGNORE INTO tags (name, kind) VALUES (?, ?)`).run(clean, kind);
  const tag = db.query<{ id: number }, [string]>(`SELECT id FROM tags WHERE name = ?`).get(clean)!;
  db.query(
    `INSERT INTO company_tags (company_id, tag_id, note) VALUES (?, ?, ?)
     ON CONFLICT(company_id, tag_id) DO UPDATE SET note = COALESCE(excluded.note, note)`,
  ).run(companyId, tag.id, note?.trim() || null);
}

export const removeTag = (companyId: number, tagId: number) =>
  db.query(`DELETE FROM company_tags WHERE company_id = ? AND tag_id = ?`).run(companyId, tagId);

/** Reminders get checked off rather than deleted, so the history stays honest. */
export const setTagDone = (companyId: number, tagId: number, done: boolean) =>
  db.query(`UPDATE company_tags SET done = ? WHERE company_id = ? AND tag_id = ?`)
    .run(done ? 1 : 0, companyId, tagId);

// --- history ----------------------------------------------------------------

/** Field/record separators for the packed tag column (see listHistory). */
export const REC_SEP = String.fromCharCode(30);
export const FLD_SEP = String.fromCharCode(31);

export interface HistoryRow {
  id: number; name: string; city: string | null; website: string | null;
  campaigns: string; last_contact: string; channels: string; send_count: number;
  tags: string | null; open_reminders: number;
}

/** Unpacks the group_concat'd tag column into usable objects. */
export const unpackTags = (packed: string | null): CompanyTag[] =>
  !packed ? [] : packed.split(REC_SEP).map((rec) => {
    const [name, kind, done] = rec.split(FLD_SEP);
    return {
      id: 0, name: name ?? "", kind: (kind ?? "label") as "label" | "reminder",
      note: null, done: (done === "1" ? 1 : 0) as 0 | 1, added_at: "",
    };
  });

/**
 * Every company ever contacted, newest first. Tags are packed by group_concat
 * rather than fetched per row -- one query instead of N+1.
 */
export function listHistory(tagId?: number, campaign?: string): HistoryRow[] {
  const clauses = ["s.status IN ('queued','sent')"];
  const params: (number | string)[] = [];
  if (tagId) {
    clauses.push(`EXISTS (SELECT 1 FROM company_tags ct WHERE ct.company_id = c.id AND ct.tag_id = ?)`);
    params.push(tagId);
  }
  if (campaign) { clauses.push(`s.campaign = ?`); params.push(campaign); }

  return db.query<HistoryRow, (number | string)[]>(`
    SELECT c.id, c.name, c.city, c.website,
           GROUP_CONCAT(DISTINCT s.campaign)     AS campaigns,
           MAX(COALESCE(s.sent_at, s.queued_at)) AS last_contact,
           GROUP_CONCAT(DISTINCT s.channel)      AS channels,
           COUNT(DISTINCT s.id)                  AS send_count,
           (SELECT GROUP_CONCAT(t.name || char(31) || t.kind || char(31) || ct.done, char(30))
              FROM company_tags ct JOIN tags t ON t.id = ct.tag_id
             WHERE ct.company_id = c.id)         AS tags,
           (SELECT COUNT(*) FROM company_tags ct JOIN tags t ON t.id = ct.tag_id
             WHERE ct.company_id = c.id AND t.kind = 'reminder' AND ct.done = 0)
                                                 AS open_reminders
    FROM companies c JOIN sends s ON s.company_id = c.id
    WHERE ${clauses.join(" AND ")}
    GROUP BY c.id
    ORDER BY last_contact DESC`).all(...params);
}

/**
 * Every campaign, newest first -- including ones created but not yet sent
 * under, which is why this reads from `campaigns` rather than from `sends`.
 */
export const listCampaigns = (): CampaignRow[] =>
  db.query<CampaignRow, []>(`
    SELECT c.name AS campaign,
           (SELECT COUNT(*) FROM sends s
             WHERE s.campaign = c.name AND s.status IN ('queued','sent')) AS n,
           (SELECT COUNT(*) FROM sends s
             WHERE s.campaign = c.name AND s.status = 'sent') AS sent,
           (SELECT COUNT(*) FROM sends s
             WHERE s.campaign = c.name AND s.status = 'queued') AS queued,
           (SELECT MAX(COALESCE(s.sent_at, s.queued_at)) FROM sends s
             WHERE s.campaign = c.name) AS last,
           c.created_at,
           c.default_template_id,
           t.name AS default_template_name
    FROM campaigns c
    LEFT JOIN templates t ON t.id = c.default_template_id
    ORDER BY c.created_at DESC, c.id DESC`).all();

export { campaignDefaultTemplate, setCampaignDefaultTemplate };

/** Renames nothing and deletes nothing if the campaign has any sends against
 *  it -- the log has to stay readable. */
export function deleteCampaign(name: string): void {
  if (name === currentCampaign())
    throw new Error("That is the current campaign. Switch to another one first.");
  const used = db.query<{ n: number }, [string]>(
    `SELECT COUNT(*) n FROM sends WHERE campaign = ?`).get(name)?.n ?? 0;
  if (used) throw new Error(`"${name}" is on ${used} logged message(s) and is kept for the record.`);
  const res = db.query(`DELETE FROM campaigns WHERE name = ?`).run(name);
  if (!res.changes) throw new Error(`No campaign named "${name}".`);
}

// --- templates --------------------------------------------------------------

const SAMPLE_CONTEXT: MergeContext = {
  company: "Acme", city: "Huntsville", state: "AL", website: "https://acme.example",
  sender_name: "Sender",
};

/** Throws on an unknown merge field, so a typo like {{compnay}} is caught at
 *  save time instead of surfacing later as "(template error)" in a preview. */
function validateTemplate(name: string, subject: string, body: string) {
  if (!name.trim()) throw new Error("Template name cannot be empty.");
  if (!subject.trim()) throw new Error("Subject cannot be empty.");
  if (!body.trim()) throw new Error("Body cannot be empty.");
  render(subject, SAMPLE_CONTEXT);
  render(body, SAMPLE_CONTEXT);
}

export function createTemplate(
  name: string, subject: string, body: string, includeFooter = true,
): number {
  validateTemplate(name, subject, body);
  try {
    return Number(db.query(
      `INSERT INTO templates (name, subject, body, include_footer) VALUES (?, ?, ?, ?)`)
      .run(name.trim(), subject, body, includeFooter ? 1 : 0).lastInsertRowid);
  } catch (e) {
    if (String(e).includes("UNIQUE")) throw new Error(`A template named "${name.trim()}" already exists.`);
    throw e;
  }
}

export function updateTemplate(
  id: number, name: string, subject: string, body: string, includeFooter = true,
) {
  validateTemplate(name, subject, body);
  try {
    db.query(`UPDATE templates SET name = ?, subject = ?, body = ?, include_footer = ? WHERE id = ?`)
      .run(name.trim(), subject, body, includeFooter ? 1 : 0, id);
  } catch (e) {
    if (String(e).includes("UNIQUE")) throw new Error(`A template named "${name.trim()}" already exists.`);
    throw e;
  }
}

/**
 * Sent messages keep a reference to their template, so a template that has been
 * used is kept for the log. Companies merely set to use it are cleared.
 */
export function deleteTemplate(id: number) {
  const used = db.query<{ n: number }, [number]>(
    `SELECT COUNT(*) n FROM sends WHERE template_id = ?`).get(id)?.n ?? 0;
  if (used) throw new Error(`This template is on ${used} logged message(s) and is kept for the record.`);
  const total = db.query<{ n: number }, []>(`SELECT COUNT(*) n FROM templates`).get()?.n ?? 0;
  if (total <= 1) throw new Error("Keep at least one template.");
  db.transaction(() => {
    db.query(`UPDATE companies SET template_id = NULL WHERE template_id = ?`).run(id);
    db.query(`DELETE FROM templates WHERE id = ?`).run(id);
  })();
}

// --- do not contact ---------------------------------------------------------

export interface Suppression { id: number; value: string; kind: "address" | "domain";
  reason: string | null; created_at: string }

export const listSuppressions = () =>
  db.query<Suppression, []>(`SELECT * FROM suppressions ORDER BY created_at DESC`).all();

/** Accepts an address, a bare domain, or a pasted URL. */
export function addSuppression(raw: string, reason?: string) {
  const v = raw.trim().toLowerCase();
  if (!v) throw new Error("Enter an address or a domain.");
  const kind = v.includes("@") ? "address" : "domain";
  const value = kind === "address" ? v : (hostOf(v.includes("://") ? v : `https://${v}`) ?? "");
  if (!value) throw new Error(`"${raw.trim()}" is not an address or a domain.`);
  db.query(`INSERT INTO suppressions (value, kind, reason) VALUES (?, ?, ?)
            ON CONFLICT(value) DO UPDATE SET reason = COALESCE(excluded.reason, reason)`)
    .run(value, kind, reason?.trim() || null);
}

export const removeSuppression = (id: number) =>
  db.query(`DELETE FROM suppressions WHERE id = ?`).run(id);

/** "Do not contact" on a company: blocks its website domain, which also covers
 *  form contacts. Falls back to the primary address when there is no site. */
export function suppressCompany(companyId: number, reason: string) {
  const row = db.query<{ website: string | null; address: string | null }, [number]>(
    `SELECT c.website, e.address FROM companies c
     LEFT JOIN emails e ON e.company_id = c.id AND e.is_primary = 1 WHERE c.id = ?`).get(companyId);
  const target = hostOf(row?.website) ?? row?.address;
  if (!target) throw new Error("This company has no website or address to block.");
  addSuppression(target, reason);
}
