// Semi-automatic contact-form fill, for companies with no findable address.
//
// DESIGN RULE: this NEVER submits. It launches a headed browser, navigates to
// the company's own contact form, fills the rendered message, and then hands
// control to you. You read it and click submit yourself.
//
// Why: it keeps a human accountable for every outbound message, sidesteps
// CAPTCHA entirely, and still removes the retyping. It is also why we do not
// touch the Chamber's own "Send Email" relay -- blasting that would put the
// Chamber's name on ~500 messages traceable to one member.

import { chromium } from "playwright";

/** Heuristics for locating the message box on an unknown contact form. */
const MESSAGE_SELECTORS = [
  "textarea[name*=message i]",
  "textarea[name*=comment i]",
  "textarea",
];

/** TODO: open form, best-effort fill name/email/message, then await human. */
export async function assist(_companyId: number): Promise<void> {
  const browser = await chromium.launch({ headless: false }); // headed, always
  void browser;
  void MESSAGE_SELECTORS;
  throw new Error("not implemented");
}

if (import.meta.main) throw new Error("not implemented");
