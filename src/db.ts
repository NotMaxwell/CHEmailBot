import { Database } from "bun:sqlite";
import { dirname, isAbsolute, join } from "node:path";
import { mkdirSync } from "node:fs";
import { config, ROOT } from "./config.ts";
import { hostOf } from "./url.ts";

export { ROOT };

/**
 * Project root, derived from THIS FILE's location rather than process.cwd().
 *
 * With a cwd-relative path, starting the server from anywhere but the repo
 * root either crashes or -- worse -- silently creates a second, empty database
 * and presents it as your data. Anchoring to the module location means the
 * same database opens no matter where the process is launched from.
 */

/**
 * Where a configured DB_PATH actually points. Relative paths resolve against
 * the project root -- never the cwd, which is what let a stray empty database
 * be created when the server was started from elsewhere.
 */
export function resolveDbPath(dbPath: string, root: string): string {
  if (dbPath === ":memory:" || dbPath === "") return dbPath;
  return isAbsolute(dbPath) ? dbPath : join(root, dbPath);
}

const IN_MEMORY = config.dbPath === ":memory:" || config.dbPath === "";

/** Absolute path to the database actually in use. */
export const DB_FILE = resolveDbPath(config.dbPath, ROOT);

if (!IN_MEMORY) mkdirSync(dirname(DB_FILE), { recursive: true });

export const db = new Database(DB_FILE, { create: true });
db.exec(await Bun.file(join(ROOT, "data/schema.sql")).text());

/**
 * Checkpoint the WAL and close cleanly.
 *
 * Note: WAL is already crash-safe -- a `kill -9` loses nothing, SQLite replays
 * the log on next open. This is hygiene (it folds the -wal file back into the
 * main database), not the thing that makes data durable.
 */
let closed = false;
export function closeDb(): void {
  if (closed || IN_MEMORY) return;
  closed = true;
  try { db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); } catch { /* already gone */ }
  try { db.close(); } catch { /* already closed */ }
}
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => { closeDb(); process.exit(0); });
}
process.on("exit", closeDb);

/**
 * Collapse a display name to a dedup key.
 * 'A-P-T Research, Inc. (APT)' and 'APT Research Inc' must collide.
 */
export function nameKey(display: string): string {
  return display
    .toLowerCase()
    .replace(/\([^)]*\)/g, " ")                                   // drop parentheticals
    .replace(/\b(inc|llc|l\.l\.c|corp|corporation|co|company|ltd|lp|llp|plc|the)\b/g, " ")
    .replace(/[^a-z0-9]+/g, "")                                   // strip punctuation AND spaces
    .trim();
}

/** True if the address or its domain sits on the suppression list. */
export function isSuppressed(address: string): boolean {
  const domain = address.split("@")[1] ?? "";
  const row = db
    .query<{ n: number }, [string, string]>(
      `SELECT COUNT(*) AS n FROM suppressions
       WHERE (kind = 'address' AND value = ?)
          OR (kind = 'domain'  AND value = ?)`,
    )
    .get(address.toLowerCase(), domain.toLowerCase());
  return (row?.n ?? 0) > 0;
}

/** True if this exact domain (with or without www.) is suppressed. */
export function isDomainSuppressed(domain: string): boolean {
  const d = domain.toLowerCase().replace(/^www\./, "");
  return (db.query<{ n: number }, [string]>(
    `SELECT COUNT(*) AS n FROM suppressions WHERE kind = 'domain' AND value = ?`,
  ).get(d)?.n ?? 0) > 0;
}

/**
 * The reason this company must not be contacted, or null.
 * Checks the website's domain as well as the primary address -- a form contact
 * has no address at all, so an opt-out recorded against the domain is the only
 * thing that can stop it.
 */
export function companySuppression(companyId: number): string | null {
  const row = db.query<{ website: string | null; address: string | null }, [number]>(
    `SELECT c.website, e.address FROM companies c
     LEFT JOIN emails e ON e.company_id = c.id AND e.is_primary = 1
     WHERE c.id = ?`,
  ).get(companyId);
  if (!row) return null;
  const site = hostOf(row.website);
  if (site && isDomainSuppressed(site)) return `${site} is on the do-not-contact list.`;
  if (row.address && isSuppressed(row.address)) return `${row.address} is on the do-not-contact list.`;
  return null;
}

/**
 * Has this company already been contacted *in this campaign*?
 * Mirrors the partial unique index above -- this is the friendly pre-check for
 * the UI; the index is the actual guarantee.
 */
export function alreadyContacted(companyId: number, campaign?: string): boolean {
  const row = db
    .query<{ n: number }, [number, string]>(
      `SELECT COUNT(*) AS n FROM sends
       WHERE company_id = ? AND campaign = ? AND status IN ('queued','sent')`,
    )
    .get(companyId, campaign ?? currentCampaign());
  return (row?.n ?? 0) > 0;
}

/** Contact in any PRIOR campaign. Not a block -- a warning worth seeing. */
export function priorContact(companyId: number): { campaign: string; sent_at: string | null } | null {
  return db.query<{ campaign: string; sent_at: string | null }, [number, string]>(
    `SELECT campaign, sent_at FROM sends
     WHERE company_id = ? AND campaign <> ? AND status IN ('queued','sent')
     ORDER BY COALESCE(sent_at, queued_at) DESC LIMIT 1`,
  ).get(companyId, currentCampaign());
}

/**
 * Adds a column if the table lacks it. schema.sql uses CREATE TABLE IF NOT
 * EXISTS, which silently ignores new columns on an existing database -- this
 * closes that gap so an older .db file still picks up schema additions.
 */
export function ensureColumn(table: string, column: string, decl: string): boolean {
  const cols = db.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all();
  if (cols.some((c) => c.name === column)) return false;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
  return true;                       // true ONLY on the run that adds it
}
ensureColumn("emails", "verified", "INTEGER NOT NULL DEFAULT 0");
ensureColumn("companies", "template_id", "INTEGER REFERENCES templates(id)");
ensureColumn("sends", "campaign", "TEXT NOT NULL DEFAULT 'initial-outreach'");
ensureColumn("campaigns", "default_template_id", "INTEGER REFERENCES templates(id)");
ensureColumn("sends", "attempted_at", "TEXT");
ensureColumn("companies", "emails_checked_at", "TEXT");
// Who signs the message. Null means "use SENDER_NAME from .env", which is
// what every company did before this column existed.
ensureColumn("companies", "sender_name", "TEXT");
// Copied onto the send at queue time so the From line still matches the
// signature months later, even if the company row is edited afterwards.
ensureColumn("sends", "sender_name", "TEXT");
// Who sent it. Null on rows queued before accounts existed.
ensureColumn("sends", "student_id", "INTEGER REFERENCES students(id)");
// Sign-up is admin-approved, and NULL here means "still waiting". Every
// account that already existed could already sign in, so the backfill runs on
// the one pass that adds the column -- without it, an upgrade would lock the
// whole team out and leave nobody able to approve anyone.
if (ensureColumn("students", "approved_at", "TEXT")) {
  db.exec(`UPDATE students SET approved_at = created_at`);
}
ensureColumn("students", "approved_by", "INTEGER REFERENCES students(id)");
// A leftover column from when the CAN-SPAM footer was opt-in per template
// (1.4.0). It is unconditional now (see mail/render.ts#footer), so nothing
// reads or writes this column any more; it is left in place on existing
// databases rather than migrated away.

db.exec(`
  -- carry the single legacy category into the many-to-many table
  INSERT OR IGNORE INTO company_categories (company_id, category)
    SELECT id, category FROM companies WHERE category IS NOT NULL;
  -- Budget rows used to be created by merely VIEWING the dashboard, which
  -- advanced the warm-up ramp with nothing sent. A row that sent nothing
  -- carries no information; drop them so the ramp reflects real sending days.
  DELETE FROM send_budget WHERE used = 0;
`);

/**
 * THE DEDUP GUARANTEE, scoped to a campaign.
 *
 * A company (and an address) may hold at most one live or successful send
 * *within a single campaign*. Rows that failed or bounced fall OUT of the
 * index, so a genuine retry still works -- but an accidental second send is
 * rejected by SQLite itself, not by app logic anyone might refactor around.
 *
 * Scoping to campaign is what lets you deliberately re-contact a past company
 * about a new event, while still making a duplicate inside one outreach
 * impossible. Cross-campaign contact is surfaced as a visible warning in the
 * review UI instead -- see queue.blockersFor().
 *
 * These live here rather than schema.sql because they depend on the `campaign`
 * column, which on a pre-existing database appears only once the ensureColumn
 * call above has run.
 */
db.exec(`
  DROP INDEX IF EXISTS sends_one_per_company;
  DROP INDEX IF EXISTS sends_one_per_address;
  CREATE UNIQUE INDEX IF NOT EXISTS sends_one_per_company_campaign
    ON sends(campaign, company_id) WHERE status IN ('queued','sent');
  CREATE UNIQUE INDEX IF NOT EXISTS sends_one_per_address_campaign
    ON sends(campaign, email_address) WHERE status IN ('queued','sent');
`);

// Backfill: campaign names that only ever existed as strings on sends rows
// (written before the campaigns table existed) become real rows.
db.exec(`INSERT OR IGNORE INTO campaigns (name) SELECT DISTINCT campaign FROM sends`);

export const getSetting = (key: string, fallback = ""): string =>
  db.query<{ value: string }, [string]>(`SELECT value FROM settings WHERE key = ?`)
    .get(key)?.value ?? fallback;

export function setSetting(key: string, value: string): void {
  db.query(`INSERT INTO settings (key, value) VALUES (?, ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, value);
}

/** The campaign new sends are filed under. */
export const currentCampaign = (): string =>
  getSetting("current_campaign", "initial-outreach");

/** Creates a campaign if new, then makes it current. Returns the clean name. */
export function switchCampaign(name: string): string {
  const clean = name.trim();
  if (!clean) throw new Error("Campaign name cannot be empty.");
  if (clean.length > 60) throw new Error("Campaign name is too long (60 characters max).");
  db.query(`INSERT OR IGNORE INTO campaigns (name) VALUES (?)`).run(clean);
  setSetting("current_campaign", clean);
  return clean;
}

/**
 * The campaign's fallback template: used by any company that has not had one
 * chosen explicitly. Setting this once is what makes a 300-company campaign
 * workable -- otherwise step 4 is a dropdown you touch 300 times.
 *
 * Null is a legitimate value and means "no fallback": companies must then each
 * pick one, exactly as before this existed.
 */
export const campaignDefaultTemplate = (campaign = currentCampaign()): number | null =>
  db.query<{ default_template_id: number | null }, [string]>(
    `SELECT default_template_id FROM campaigns WHERE name = ?`).get(campaign)?.default_template_id ?? null;

export function setCampaignDefaultTemplate(campaign: string, templateId: number | null): void {
  if (templateId !== null) {
    const exists = db.query<{ n: number }, [number]>(
      `SELECT COUNT(*) n FROM templates WHERE id = ?`).get(templateId)?.n ?? 0;
    if (!exists) throw new Error(`No template with id ${templateId}.`);
  }
  const res = db.query(`UPDATE campaigns SET default_template_id = ? WHERE name = ?`)
    .run(templateId, campaign);
  if (!res.changes) throw new Error(`No campaign named "${campaign}".`);
}
