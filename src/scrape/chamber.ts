// Stage 1: harvest companies from the Huntsville/Madison County Chamber.
//
// VERIFIED against the live site (see tests/fixtures/):
//   - robots.txt permits /list, /list/category/*, /list/member/*
//     (only /list/search is Disallow'd -- never hit it)
//   - category pages list every member inline; no pagination observed
//   - member pages expose name/address/phone/website/linkedin via itemprops
//   - *** NO EMAIL ADDRESSES EXIST HERE *** The contact slot renders the
//     literal string "Send Email" behind javascript:void(0) -- a Chamber-relayed
//     form. We deliberately do NOT automate that relay; see src/forms/assist.ts.
//     Email resolution happens in discover.ts against the company's own site.

import { config } from "../config.ts";
import { memberSlugs, parseMember } from "./parse.ts";
import { upsertCompany } from "../repo.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface SyncProgress {
  category: string; done: number; total: number;
  inserted: number; updated: number; duplicate: number; failed: number;
}

async function fetchPolitely(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: { "User-Agent": config.scrape.userAgent },
    // Without this a single hung connection froze the scrape indefinitely --
    // and held the one-job-at-a-time lock, blocking every other button.
    signal: AbortSignal.timeout(config.scrape.timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const text = await res.text();
  await sleep(config.scrape.delayMs);   // rate limit AFTER the read, always
  return text;
}

export async function listCategory(categorySlug: string): Promise<string[]> {
  return memberSlugs(
    await fetchPolitely(`${config.scrape.chamberBase}/list/category/${categorySlug}`),
  );
}

export async function fetchMember(slug: string) {
  const parsed = parseMember(
    await fetchPolitely(`${config.scrape.chamberBase}/list/member/${slug}`),
  );
  return { ...parsed, chamber_slug: slug };
}

/**
 * Full sync across the configured technology categories.
 * `onProgress` is polled by the web UI so the scrape is watchable.
 */
export async function syncAll(
  onProgress?: (p: SyncProgress) => void,
): Promise<SyncProgress[]> {
  const results: SyncProgress[] = [];

  for (const category of config.scrape.techCategories) {
    const p: SyncProgress = {
      category, done: 0, total: 0,
      inserted: 0, updated: 0, duplicate: 0, failed: 0,
    };
    results.push(p);

    let slugs: string[] = [];
    try {
      slugs = await listCategory(category);
    } catch (err) {
      p.failed++;
      onProgress?.(p);
      continue;
    }
    p.total = slugs.length;
    onProgress?.(p);

    for (const slug of slugs) {
      try {
        const m = await fetchMember(slug);
        if (!m.name) { p.failed++; continue; }
        const outcome = upsertCompany({
          chamber_slug: m.chamber_slug,
          name: m.name,
          website: m.website,
          phone: m.phone,
          street: m.street,
          city: m.city,
          state: m.state,
          postal_code: m.postal_code,
          linkedin: m.linkedin,
          category,
        });
        p[outcome]++;
      } catch {
        p.failed++;
      }
      p.done++;
      onProgress?.(p);
    }
  }
  return results;
}

if (import.meta.main) {
  const res = await syncAll((p) =>
    process.stdout.write(`\r${p.category}: ${p.done}/${p.total}   `));
  console.log("\n", res);
}
