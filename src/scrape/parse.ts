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

/** Addresses that are never a real human contact. */
const JUNK = /(^|@)(sentry|wixpress|example|sentry\.io|godaddy|squarespace|\d+x\d+)|\.(png|jpe?g|gif|svg|webp|css|js)$/i;

export interface FoundEmail {
  address: string;
  source: "mailto" | "contact_page";
  confidence: number;
}

/**
 * Harvest addresses from a company's own page.
 * mailto: links score 1.0; bare text matches score 0.8. Anything at or below
 * 0.8 still requires human approval before it can be queued.
 */
export function harvestEmails(html: string): FoundEmail[] {
  const found = new Map<string, FoundEmail>();

  for (const m of html.matchAll(/href="mailto:([^"?]+)/gi)) {
    const address = decode(m[1] ?? "").toLowerCase();
    if (address && !JUNK.test(address) && ADDR.test(address)) {
      ADDR.lastIndex = 0;
      found.set(address, { address, source: "mailto", confidence: 1.0 });
    }
  }

  const text = html.replace(/<script[\s\S]*?<\/script>/gi, " ")
                   .replace(/<style[\s\S]*?<\/style>/gi, " ")
                   .replace(/<[^>]+>/g, " ");
  for (const m of text.matchAll(ADDR)) {
    const address = m[0].toLowerCase();
    if (!JUNK.test(address) && !found.has(address)) {
      found.set(address, { address, source: "contact_page", confidence: 0.8 });
    }
  }

  return [...found.values()].sort((a, b) => b.confidence - a.confidence);
}
