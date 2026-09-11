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

import { chromium, type Page } from "playwright";
import { config } from "../config.ts";
import { getCompany, getTemplate } from "../repo.ts";
import { render, contextFor, footer } from "../mail/render.ts";
import { CONTACT_PATHS } from "../scrape/discover.ts";

/** Heuristics for locating fields on an unknown contact form. */
const MESSAGE_SELECTORS = [
  "textarea[name*=message i]", "textarea[name*=comment i]",
  "textarea[id*=message i]", "textarea",
];
const NAME_SELECTORS = [
  "input[name*=name i]:not([name*=company i]):not([name*=user i])",
  "input[id*=name i]", "input[placeholder*=name i]",
];
const EMAIL_SELECTORS = [
  "input[type=email]", "input[name*=email i]", "input[placeholder*=email i]",
];

/** Fills the first selector that matches a visible field. Returns what it used. */
async function fillFirst(page: Page, selectors: string[], value: string): Promise<string | null> {
  for (const sel of selectors) {
    const field = page.locator(sel).first();
    try {
      if (await field.isVisible({ timeout: 1000 })) {
        await field.fill(value);
        return sel;
      }
    } catch { /* not present on this page; try the next */ }
  }
  return null;
}

/**
 * Opens the company's contact form with your message pre-filled, then blocks
 * until you close the browser. Nothing is ever submitted programmatically.
 */
export async function assist(companyId: number): Promise<void> {
  const company = getCompany(companyId);
  if (!company) throw new Error(`No company with id ${companyId}`);
  if (!company.website) throw new Error(`${company.name} has no website on file`);
  if (!company.template_id) throw new Error(`${company.name} has no template selected (step 4)`);

  const template = getTemplate(company.template_id);
  if (!template) throw new Error("Selected template no longer exists");

  const ctx = contextFor(company);
  const message = render(template.body, ctx) + footer();

  const browser = await chromium.launch({ headless: false });   // headed, always
  const page = await browser.newPage();

  let landed: string | null = null;
  for (const path of CONTACT_PATHS) {
    const url = new URL(path, company.website).href;
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20_000 });
    } catch { continue; }
    if (await page.locator(MESSAGE_SELECTORS.join(", ")).first()
                   .isVisible({ timeout: 2000 }).catch(() => false)) {
      landed = url;
      break;
    }
  }

  if (!landed) {
    console.log(`No contact form found on ${company.website}. Browser is open — navigate yourself.`);
  } else {
    const filled = await fillFirst(page, MESSAGE_SELECTORS, message);
    await fillFirst(page, NAME_SELECTORS, config.canSpam.senderName);
    await fillFirst(page, EMAIL_SELECTORS, config.gmail.sender);
    console.log(`Form found at ${landed} (message field: ${filled ?? "none"})`);
  }

  console.log(
    `\n  ${company.name}\n` +
    `  Review the message, then SUBMIT IT YOURSELF.\n` +
    `  Close the browser when done — then mark it contacted in the UI so the\n` +
    `  dedup ledger knows about it.\n`,
  );

  await new Promise<void>((resolve) => browser.on("disconnected", () => resolve()));
}

if (import.meta.main) {
  const id = Number(process.argv[2]);
  if (!id) throw new Error("usage: bun run src/forms/assist.ts <companyId>");
  await assist(id);
}
