// Pure HTML extraction. No dependencies, no I/O -- everything here is a string
// in, data out, so it can be tested offline against the fixtures in
// tests/fixtures/ without a network or a browser.
//
// The Chamber runs GrowthZone/ChamberMaster, which emits very regular
// schema.org itemprop markup. That regularity is why hand-rolled extraction is
// safe here and we don't need a DOM library.

export interface ParsedMember {
  name: string | null;
  street: string | null;
  city: string | null;
  state: string | null;
  postal_code: string | null;
  phone: string | null;
  website: string | null;
  linkedin: string | null;
  /** What the Chamber shows in the email slot. Always the literal string
   *  "Send Email" -- proof no address is published. Never an address. */
  emailSlot: string | null;
}

const ENTITIES: Record<string, string> = {
  "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"',
  "&#39;": "'", "&apos;": "'", "&nbsp;": " ",
};

export function decode(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCharCode(Number(d)))
    .replace(/&[a-z#0-9]+;/gi, (e) => ENTITIES[e] ?? e)
    .replace(/\s+/g, " ")
    .trim();
}

/** Text content of the first element carrying itemprop="<prop>". */
export function itemprop(html: string, prop: string): string | null {
  const m = html.match(new RegExp(`itemprop="${prop}"[^>]*>([^<]*)<`, "i"));
  return m?.[1] ? decode(m[1]) || null : null;
}

/** href of the first <a> tag whose attributes match `attrPattern`. */
function anchorHref(html: string, attrPattern: string): string | null {
  const tag = html.match(new RegExp(`<a\\b([^>]*${attrPattern}[^>]*)>`, "i"));
  return tag?.[1]?.match(/href="([^"]+)"/i)?.[1] ?? null;
}

/** Unique member slugs from a category listing page, in document order. */
export function memberSlugs(html: string): string[] {
  const out = new Set<string>();
  for (const m of html.matchAll(/\/list\/member\/([a-z0-9][a-z0-9-]*)/gi)) {
    if (m[1]) out.add(m[1].toLowerCase());
  }
  return [...out];
}

export function parseMember(html: string): ParsedMember {
  return {
    name: itemprop(html, "name"),
    street: itemprop(html, "streetAddress"),
    city: itemprop(html, "addressLocality"),
    state: itemprop(html, "addressRegion"),
    postal_code: itemprop(html, "postalCode"),
    phone: itemprop(html, "telephone"),
    website: anchorHref(html, 'itemprop="url"'),
    linkedin: anchorHref(html, "gz-social-linkedin"),
    emailSlot: itemprop(html, "email"),
  };
}

// --- company-site email discovery -------------------------------------------

const ADDR = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/** Domains that are never a human contact: telemetry, CDNs, vendor boilerplate. */
const JUNK_DOMAIN =
  /(sentry\.io|\.ingest\.|wixpress|squarespace|godaddy|cloudflare|googleapis|gstatic|jquery|w3\.org|schema\.org|doubleclick|sentry|^test\.)/i;

/** Placeholder domains used in form examples -- never a real recipient. */
const PLACEHOLDER_DOMAIN =
  /^(example|domain|yourdomain|yourcompany|company|email|youremail|mydomain|mysite|website|site|abc|xyz)\.(com|org|net|co)$/i;

/** Local parts that are machine keys rather than names (e.g. Sentry DSNs). */
const JUNK_LOCAL = /^[0-9a-f]{16,}$/i;

export function isJunkAddress(address: string): boolean {
  const [local = "", domain = ""] = address.split("@");
  if (/\.(png|jpe?g|gif|svg|webp|css|js|woff2?|ico)$/i.test(address)) return true;
  if (JUNK_DOMAIN.test(domain) || PLACEHOLDER_DOMAIN.test(domain)) return true;
  if (JUNK_LOCAL.test(local)) return true;
  if (/\d+x\d+/.test(local)) return true;                 // image dimensions
  return false;
}

/**
 * Does this address plausibly belong to the company whose site we crawled?
 *
 * Exact host matching is too strict -- federal.octave.com legitimately uses
 * info@octavefederal.com, and ingentis.com uses mail@ingentis.de. So instead we
 * look for a shared word of real length between the two domains. Without one,
 * the address is probably a third party (a vendor, an accountant, a partner)
 * and must not silently become the outreach target.
 */
export function sameOrg(siteHost: string, emailDomain: string): boolean {
  const words = (h: string) =>
    h.toLowerCase().replace(/^www\./, "").split(/[.\-]/)
      .filter((w) => w.length >= 4 && !["com","net","org","co","inc","llc","www"].includes(w));
  const norm = (h: string) => h.toLowerCase().replace(/^www\./, "");
  const site = words(siteHost);
  const mail = words(emailDomain);
  // Short labels (biz-bob.com -> biz/bob/com) survive no filter, so fall back
  // to comparing the hosts directly rather than declaring them unrelated.
  if (!site.length || !mail.length) {
    const a = norm(siteHost), b = norm(emailDomain);
    return a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`);
  }
  return site.some((s) => mail.some((m) => s === m || s.includes(m) || m.includes(s)));
}

export interface FoundEmail {
  address: string;
  source: "mailto" | "contact_page";
  confidence: number;
}

/**
 * Harvest addresses from a company's own page.
 *
 *   1.0  mailto: link
 *   0.8  visible page text
 *   0.6  inside a <script> blob -- JS-rendered sites (Next.js and friends) put
 *        the real contact address in embedded JSON and never in the markup, so
 *        skipping scripts entirely loses genuine addresses
 *
 * Anything whose domain looks unrelated to the site is halved, because a third
 * party's address must never outrank the company's own.
 * Everything below 1.0 still requires human verification before it can queue.
 */
export function harvestEmails(html: string, siteHost = ""): FoundEmail[] {
  const found = new Map<string, FoundEmail>();

  const offer = (raw: string, source: FoundEmail["source"], base: number) => {
    const address = raw.toLowerCase().trim();
    if (!address || isJunkAddress(address)) return;
    const domain = address.split("@")[1] ?? "";
    const related = !siteHost || sameOrg(siteHost, domain);
    const confidence = related ? base : base * 0.5;
    const prev = found.get(address);
    if (!prev || confidence > prev.confidence) found.set(address, { address, source, confidence });
  };

  // Single- or double-quoted, and percent-encoded ("info%40acme.com") -- all
  // three appear in the wild; the old pattern matched only the first form.
  for (const m of html.matchAll(/href=["']mailto:([^"'?]+)/gi)) {
    let raw = m[1] ?? "";
    try { raw = decodeURIComponent(raw); } catch { /* malformed escape: use as-is */ }
    offer(raw, "mailto", 1.0);
  }

  const scripts = html.match(/<script[\s\S]*?<\/script>/gi)?.join(" ") ?? "";
  const visible = html.replace(/<script[\s\S]*?<\/script>/gi, " ")
                      .replace(/<style[\s\S]*?<\/style>/gi, " ")
                      .replace(/<[^>]+>/g, " ");

  for (const m of visible.matchAll(new RegExp(ADDR.source, "g"))) offer(m[0], "contact_page", 0.8);
  for (const m of scripts.matchAll(new RegExp(ADDR.source, "g"))) offer(m[0], "contact_page", 0.6);

  return [...found.values()].sort((a, b) => b.confidence - a.confidence);
}
