// Stage 2: resolve a real email address from each company's OWN website.
// This is the stage that replaces the emails the Chamber refuses to publish.
//
// Strategy, highest confidence first:
//   1.0  mailto: link on the homepage or a contact page
//   0.8  bare address in the text of /contact, /contact-us, /about
//   0.4  role-address guess (info@domain) -- NEVER auto-sent, review required
//
// Anything below 0.8 must be human-approved in the review queue before it can
// be queued for send.
export const CONTACT_PATHS = ["/contact", "/contact-us", "/about", "/about-us", "/team"];

/** TODO: crawl homepage + CONTACT_PATHS, collect mailto: and text matches. */
export async function discoverFor(_companyId: number): Promise<void> {
  throw new Error("not implemented");
}

if (import.meta.main) throw new Error("not implemented");
