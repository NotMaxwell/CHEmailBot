import { Database } from "bun:sqlite";
import { config } from "./config.ts";

export const db = new Database(config.dbPath, { create: true });
db.exec(await Bun.file("data/schema.sql").text());

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
export function ensureColumn(table: string, column: string, decl: string): void {
  const cols = db.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
  }
}
ensureColumn("emails", "verified", "INTEGER NOT NULL DEFAULT 0");
ensureColumn("companies", "template_id", "INTEGER REFERENCES templates(id)");
ensureColumn("sends", "campaign", "TEXT NOT NULL DEFAULT 'initial-outreach'");

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
