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
/**
 * Contact pages FIRST, homepage last -- the opposite of discover.ts, which
 * wants the homepage early because a mailto: there is as good as any other.
 * For forms the homepage is the worst candidate: a bare <textarea> on it is
 * usually a newsletter or search box, not a way to reach a human.
 */
const FORM_PATHS = ["/contact", "/contact-us", "/contact.html", "/about", "/about-us", ""];

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

/**
 * Waits for a selector to become visible.
 * Deliberately NOT locator.isVisible() -- that returns immediately and its
 * timeout option is ignored, so a form still rendering reads as absent.
 */
async function visible(page: Page, selector: string, timeout: number): Promise<boolean> {
  try {
    await page.locator(selector).first().waitFor({ state: "visible", timeout });
    return true;
  } catch {
    return false;
  }
}

/** Fills the first selector that matches a visible field. Returns what it used. */
async function fillFirst(page: Page, selectors: string[], value: string): Promise<string | null> {
  for (const sel of selectors) {
    if (!(await visible(page, sel, 1500))) continue;
    try {
      await page.locator(sel).first().fill(value);
      return sel;
    } catch { /* readonly, detached, or covered -- try the next */ }
  }
  return null;
}

/**
 * Did we find a real contact form, or just something textarea-shaped?
 * A *named* message field (name/id contains "message"/"comment") is strong
 * evidence. A bare `textarea` only counts when a name AND email field sit
 * beside it -- otherwise it is likely a newsletter or search box.
 */
export function isConfident(
  messageField: string | null, nameField: string | null, emailField: string | null,
): boolean {
  if (messageField === null) return false;
  if (messageField !== "textarea") return true;
  return nameField !== null && emailField !== null;
}

export interface FillResult {
  url: string;
  messageField: string | null;
  nameField: string | null;
  emailField: string | null;
  /** False when the message box matched only the bare `textarea` fallback --
   *  often a newsletter or search box rather than a real contact form. */
  confident: boolean;
}

/**
 * Finds the company's contact form and fills it. Split out from assist() so it
 * can be exercised headlessly against real sites without blocking on a human.
 * Returns null when no form with a message box could be found.
 */
export async function findAndFill(
  page: Page, website: string, message: string,
  senderName: string, senderEmail: string,
): Promise<FillResult | null> {
  for (const path of FORM_PATHS) {
    let url: string;
    try { url = new URL(path, website).href; } catch { continue; }
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20_000 });
    } catch { continue; }

    if (!(await visible(page, MESSAGE_SELECTORS.join(", "), 4000))) continue;
    const messageField = await fillFirst(page, MESSAGE_SELECTORS, message);
    const nameField = await fillFirst(page, NAME_SELECTORS, senderName);
    const emailField = await fillFirst(page, EMAIL_SELECTORS, senderEmail);
    return { url, messageField, nameField, emailField,
             confident: isConfident(messageField, nameField, emailField) };
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

  const filled = await findAndFill(
    page, company.website, message, config.canSpam.senderName, config.gmail.sender);

  if (!filled) {
    console.log(`No contact form found on ${company.website}. Browser is open — navigate yourself.`);
  } else {
    console.log(`Form found at ${filled.url} (message field: ${filled.messageField ?? "none"})`);
    if (!filled.confident) {
      console.log("  NOTE: matched only a generic textarea — check this is the contact form,");
      console.log("        not a newsletter or search box, before you submit.");
    }
  }

  console.log(
    `\n  ${company.name}\n` +
    `  Review the message, then SUBMIT IT YOURSELF.\n` +
    `  Close the browser when done — then mark it contacted in the UI so the\n` +
    `  dedup ledger knows about it.\n`,
  );

  if (!browser.isConnected()) return;                 // already closed while filling
  await new Promise<void>((resolve) => browser.on("disconnected", () => resolve()));
}

if (import.meta.main) {
  const id = Number(process.argv[2]);
  if (!id) throw new Error("usage: bun run src/forms/assist.ts <companyId>");
  await assist(id);
}
