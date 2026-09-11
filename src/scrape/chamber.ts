// Stage 1: harvest companies from the Huntsville/Madison County Chamber.
//
// VERIFIED against the live site:
//   - robots.txt permits /list, /list/category/*, /list/member/*
//     (only /list/search is Disallow'd -- never hit it)
//   - category pages list every member inline; no pagination observed
//   - member pages expose name/address/phone/fax/website/linkedin via
//     schema.org itemprops
//   - *** NO EMAIL ADDRESSES EXIST HERE *** The contact block renders
//     `<span itemprop="email">Send Email</span>` behind javascript:void(0),
//     a Chamber-relayed form. We deliberately do NOT automate that relay.
//     Email resolution happens in discover.ts against the company's own site.

import { parse } from "node-html-parser";
import { config } from "../config.ts";
import { db, nameKey } from "../db.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetchPolitely(url: string): Promise<string> {
  const res = await fetch(url, { headers: { "User-Agent": config.scrape.userAgent } });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  await sleep(config.scrape.delayMs);
  return res.text();
}

/** Returns member slugs, e.g. 'a-p-t-research-inc-apt-164'. */
export async function listCategory(categorySlug: string): Promise<string[]> {
  const html = await fetchPolitely(
    `${config.scrape.chamberBase}/list/category/${categorySlug}`,
  );
  const slugs = new Set<string>();
  for (const a of parse(html).querySelectorAll('a[href*="/list/member/"]')) {
    const m = a.getAttribute("href")?.match(/\/list\/member\/([a-z0-9-]+)/);
    if (m?.[1]) slugs.add(m[1]);
  }
  return [...slugs];
}

/** TODO: pull itemprop name/streetAddress/addressLocality/telephone/url. */
export async function fetchMember(slug: string) {
  const html = await fetchPolitely(`${config.scrape.chamberBase}/list/member/${slug}`);
  const doc = parse(html);
  const prop = (p: string) =>
    doc.querySelector(`[itemprop="${p}"]`)?.innerText?.trim() ?? null;
  return {
    chamber_slug: slug,
    name: prop("name") ?? slug,
    street: prop("streetAddress"),
    city: prop("addressLocality"),
    state: prop("addressRegion"),
    postal_code: prop("postalCode"),
    phone: prop("telephone"),
    website: doc.querySelector('[itemprop="url"]')?.getAttribute("href") ?? null,
    linkedin: doc.querySelector('a.gz-social-linkedin')?.getAttribute("href") ?? null,
  };
}

/** TODO: upsert into companies, keyed on chamber_slug, skipping name_key dupes. */
export async function syncAll(): Promise<void> {
  throw new Error("not implemented");
}

if (import.meta.main) await syncAll();
