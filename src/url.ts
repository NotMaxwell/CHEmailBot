// URL handling for values that arrive from scraped HTML. No imports, so every
// layer (db, repo, views) can use it without creating a cycle.

/**
 * A scraped website as a safe, absolute http(s) URL -- or null.
 *
 * Adds a missing scheme ("www.acme.com" -> "https://www.acme.com/"), and
 * rejects anything that is not http or https. That rejection matters: the
 * value is rendered as a link, and HTML-escaping does nothing to stop a
 * `javascript:` URL from running when clicked.
 */
export function normalizeWebsite(raw: string | null | undefined): string | null {
  const s = raw?.trim();
  if (!s) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(s) ? s : `https://${s.replace(/^\/+/, "")}`;
  try {
    const u = new URL(withScheme);
    return u.protocol === "http:" || u.protocol === "https:" ? u.href : null;
  } catch {
    return null;
  }
}

/** Lowercased hostname without "www.", or null when the URL will not parse.
 *  Never throws -- a throwing `new URL()` in a table row 500s the whole page. */
export function hostOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "") || null;
  } catch {
    return null;
  }
}
