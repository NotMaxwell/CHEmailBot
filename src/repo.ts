// Every query the UI needs, in one place. Routes stay thin.
import { db, nameKey, isSuppressed, currentCampaign } from "./db.ts";
import type { Company, EmailCandidate } from "./types.ts";

export interface CompanyRow extends Company {
  email_count: number;
  primary_address: string | null;
  primary_verified: number | null;
  send_status: string | null;
  sent_at: string | null;
  send_channel: string | null;
  template_name: string | null;
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
  return db.query<CompanyRow, [string]>(`
    SELECT c.*,
           (SELECT COUNT(*) FROM emails WHERE company_id=c.id) AS email_count,
           e.address  AS primary_address,
           e.verified AS primary_verified,
           s.status   AS send_status,
           s.sent_at  AS sent_at,
           s.channel  AS send_channel,
           t.name     AS template_name
    FROM companies c
    LEFT JOIN emails e   ON e.company_id=c.id AND e.is_primary=1
    LEFT JOIN sends  s   ON s.company_id=c.id AND s.status IN ('queued','sent')
                        AND s.campaign = ?
    LEFT JOIN templates t ON t.id=c.template_id
    ${where}
    ORDER BY c.name COLLATE NOCASE
  `).all(campaign);
}

export const getCompany = (id: number) =>
  db.query<Company, [number]>(`SELECT * FROM companies WHERE id=?`).get(id);

export const emailsFor = (id: number) =>
  db.query<EmailCandidate, [number]>(
    `SELECT * FROM emails WHERE company_id=? ORDER BY is_primary DESC, confidence DESC`,
  ).all(id);

export const listTemplates = () =>
  db.query<{ id: number; name: string; subject: string; body: string }, []>(
    `SELECT * FROM templates ORDER BY name`,
  ).all();

export const getTemplate = (id: number) =>
  db.query<{ id: number; name: string; subject: string; body: string }, [number]>(
    `SELECT * FROM templates WHERE id=?`,
  ).get(id);

// --- the five workflow actions ---------------------------------------------

/** Step 2: verify (or reject) the company as an outreach target. */
export function setReview(id: number, status: "new" | "approved" | "rejected") {
  db.query(`UPDATE companies SET review_status=? WHERE id=?`).run(status, id);
}

/** Step 3: mark a discovered address as human-confirmed. */
export function setVerified(emailId: number, verified: boolean) {
  db.query(`UPDATE emails SET verified=? WHERE id=?`).run(verified ? 1 : 0, emailId);
}

/** Step 5: choose which of several candidate addresses the send will use. */
export function setPrimary(companyId: number, emailId: number) {
  db.transaction(() => {
    db.query(`UPDATE emails SET is_primary=0 WHERE company_id=?`).run(companyId);
    db.query(`UPDATE emails SET is_primary=1 WHERE id=? AND company_id=?`)
      .run(emailId, companyId);
  })();
}

/** Step 4: choose the template for this company. */
export function setTemplate(companyId: number, templateId: number) {
  db.query(`UPDATE companies SET template_id=? WHERE id=?`).run(templateId, companyId);
}

export function addManualEmail(companyId: number, address: string) {
  db.query(
    `INSERT OR IGNORE INTO emails (company_id,address,source,confidence,verified)
     VALUES (?,?,'manual',1.0,1)`,
  ).run(companyId, address.trim().toLowerCase());
}

export function upsertCompany(m: {
  chamber_slug: string; name: string; website: string | null; phone: string | null;
  street: string | null; city: string | null; state: string | null;
  postal_code: string | null; linkedin: string | null; category: string;
}): "inserted" | "updated" | "duplicate" {
  const key = nameKey(m.name);
  const clash = db.query<{ id: number; chamber_slug: string }, [string]>(
    `SELECT id, chamber_slug FROM companies WHERE name_key=?`,
  ).get(key);
  if (clash && clash.chamber_slug !== m.chamber_slug) return "duplicate";

  const existing = db.query<{ id: number }, [string]>(
    `SELECT id FROM companies WHERE chamber_slug=?`,
  ).get(m.chamber_slug);

  if (existing) {
    db.query(
      `UPDATE companies SET name=?,website=?,phone=?,street=?,city=?,state=?,
       postal_code=?,linkedin=?,category=? WHERE id=?`,
    ).run(m.name, m.website, m.phone, m.street, m.city, m.state,
          m.postal_code, m.linkedin, m.category, existing.id);
    return "updated";
  }
  db.query(
    `INSERT INTO companies (chamber_slug,name,name_key,website,phone,street,city,
     state,postal_code,linkedin,category) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(m.chamber_slug, m.name, key, m.website, m.phone, m.street, m.city,
        m.state, m.postal_code, m.linkedin, m.category);
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
  const one = (sql: string) => db.query<{ n: number }, []>(sql).get()?.n ?? 0;
  return {
    companies: one(`SELECT COUNT(*) n FROM companies`),
    approved:  one(`SELECT COUNT(*) n FROM companies WHERE review_status='approved'`),
    withEmail: one(`SELECT COUNT(DISTINCT company_id) n FROM emails`),
    verified:  one(`SELECT COUNT(DISTINCT company_id) n FROM emails WHERE verified=1`),
    sent:      one(`SELECT COUNT(*) n FROM sends WHERE status='sent'`),
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
export const listCampaigns = () =>
  db.query<{ campaign: string; n: number; last: string | null }, []>(`
    SELECT c.name AS campaign,
           (SELECT COUNT(*) FROM sends s
             WHERE s.campaign = c.name AND s.status IN ('queued','sent')) AS n,
           (SELECT MAX(COALESCE(s.sent_at, s.queued_at)) FROM sends s
             WHERE s.campaign = c.name) AS last
    FROM campaigns c
    ORDER BY c.created_at DESC, c.id DESC`).all();
