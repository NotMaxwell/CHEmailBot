// Stage 2: resolve a real email address from each company's OWN website.
// This replaces the addresses the Chamber refuses to publish.
//
// Confidence, highest first:
//   1.0  mailto: link
//   0.8  bare address in page text
// Anything below 1.0 still requires human verification in the review UI
// before it can be queued -- see repo.setVerified.

import { config } from "../config.ts";
import { harvestEmails } from "./parse.ts";
import { recordEmails, getCompany, markEmailsChecked } from "../repo.ts";
import { db } from "../db.ts";

export const CONTACT_PATHS = [
  "", "/contact", "/contact-us", "/contact.html", "/about", "/about-us",
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function tryFetch(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": config.scrape.userAgent },
      signal: AbortSignal.timeout(15_000),
      redirect: "follow",
    });
    if (!res.ok) return null;
    const type = res.headers.get("content-type") ?? "";
    return type.includes("html") ? await res.text() : null;
  } catch {
    return null;               // dead domain, TLS failure, timeout -- all fine
  }
}

/** Crawl one company's site and store whatever addresses turn up. */
export async function discoverFor(companyId: number): Promise<number> {
  const company = getCompany(companyId);
  if (!company?.website) return 0;

  let base: URL;
  try { base = new URL(company.website); } catch { return 0; }

  const found = new Map<string, { address: string; source: string; confidence: number }>();
  let reached = false;
  for (const path of CONTACT_PATHS) {
    const html = await tryFetch(new URL(path, base).href);
    await sleep(config.scrape.delayMs);
    if (!html) continue;
    reached = true;
    for (const e of harvestEmails(html, base.hostname)) {
      const prev = found.get(e.address);
      if (!prev || e.confidence > prev.confidence) found.set(e.address, e);
    }
    // a mailto: on the homepage is good enough; stop hammering the site
    if ([...found.values()].some((e) => e.confidence === 1.0)) break;
  }

  const list = [...found.values()];
  recordEmails(companyId, list);
  // Only a crawl that actually loaded a page counts as checked. If the network
  // was down, every site fails -- marking them all "checked, nothing found"
  // would silently exclude them from every future run.
  if (reached) markEmailsChecked(companyId);
  return list.length;
}

export interface DiscoverFailure { id: number; name: string; message: string }

export interface DiscoverProgress {
  done: number; total: number; found: number;
  /** Companies whose crawl threw. The run continues past them. */
  failures: DiscoverFailure[];
  startedAt: number;
}

/** Wall-clock estimate of what is left, from the pace so far. Without it a run
 *  that legitimately takes 40 minutes is indistinguishable from a hung one. */
export function etaSeconds(p: DiscoverProgress): number | null {
  if (!p.done || p.done >= p.total) return null;
  const perCompany = (Date.now() - p.startedAt) / p.done;
  return Math.round(((p.total - p.done) * perCompany) / 1000);
}

/** Run discovery for every company not yet successfully crawled.
 *  It used to re-crawl every company that had no address on EVERY run --
 *  a second click redid all the misses (minutes of polite, delayed fetches). */
export async function discoverAll(
  onProgress?: (p: DiscoverProgress) => void,
): Promise<DiscoverProgress> {
  const targets = db.query<{ id: number; name: string }, []>(`
    SELECT c.id, c.name FROM companies c
    WHERE c.website IS NOT NULL
      AND c.review_status <> 'rejected'
      AND c.emails_checked_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM emails e WHERE e.company_id = c.id)
    ORDER BY c.name COLLATE NOCASE
  `).all();

  const p: DiscoverProgress = {
    done: 0, total: targets.length, found: 0, failures: [], startedAt: Date.now(),
  };
  onProgress?.(p);
  for (const t of targets) {
    // One company must never end the run. tryFetch already swallows network
    // faults, but a malformed page, a DB constraint, or an out-of-memory parse
    // would otherwise kill the whole pass and -- before this -- do it silently,
    // leaving a half-crawled directory and no indication of why it stopped.
    try {
      p.found += await discoverFor(t.id);
    } catch (e) {
      p.failures.push({
        id: t.id, name: t.name,
        message: e instanceof Error ? e.message : String(e),
      });
      console.error(`discover failed for ${t.name} (#${t.id}):`, e);
    }
    p.done++;
    onProgress?.(p);
  }
  return p;
}

if (import.meta.main) {
  const p = await discoverAll((x) => {
    const eta = etaSeconds(x);
    process.stdout.write(
      `\r${x.done}/${x.total} (${x.found} addresses` +
      `${x.failures.length ? `, ${x.failures.length} failed` : ""})` +
      `${eta !== null ? ` ~${Math.ceil(eta / 60)}m left` : ""}      `);
  });
  console.log(`\n${p.done} crawled, ${p.found} addresses, ${p.failures.length} failed.`);
  for (const f of p.failures) console.log(`  #${f.id} ${f.name}: ${f.message}`);
}
