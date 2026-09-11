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
 * Has this company already been contacted (or is one already in flight)?
 * Mirrors the partial unique index in schema.sql -- this is the friendly
 * pre-check for the UI; the index is the actual guarantee.
 */
export function alreadyContacted(companyId: number): boolean {
  const row = db
    .query<{ n: number }, [number]>(
      `SELECT COUNT(*) AS n FROM sends
       WHERE company_id = ? AND status IN ('queued','sent')`,
    )
    .get(companyId);
  return (row?.n ?? 0) > 0;
}
