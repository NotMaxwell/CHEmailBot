// Every query the UI needs, in one place. Routes stay thin.
import { db, nameKey, isSuppressed } from "./db.ts";
import type { Company, EmailCandidate } from "./types.ts";

export interface CompanyRow extends Company {
  email_count: number;
  primary_address: string | null;
  primary_verified: number | null;
  send_status: string | null;
  sent_at: string | null;
  template_name: string | null;
}

/** The review-queue list, with everything the row needs to render. */
export function listCompanies(filter = "all"): CompanyRow[] {
  const where =
    filter === "ready"      ? `WHERE c.review_status='approved' AND e.verified=1 AND s.id IS NULL`
    : filter === "contacted" ? `WHERE s.id IS NOT NULL`
    : filter === "new"       ? `WHERE c.review_status='new'`
    : "";
  return db.query<CompanyRow, []>(`
    SELECT c.*,
           (SELECT COUNT(*) FROM emails WHERE company_id=c.id) AS email_count,
           e.address  AS primary_address,
           e.verified AS primary_verified,
           s.status   AS send_status,
           s.sent_at  AS sent_at,
           t.name     AS template_name
    FROM companies c
    LEFT JOIN emails e   ON e.company_id=c.id AND e.is_primary=1
    LEFT JOIN sends  s   ON s.company_id=c.id AND s.status IN ('queued','sent')
    LEFT JOIN templates t ON t.id=c.template_id
    ${where}
    ORDER BY c.name COLLATE NOCASE
  `).all();
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
