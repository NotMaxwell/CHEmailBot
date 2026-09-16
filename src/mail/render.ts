import type { Company, MergeContext } from "../types.ts";
import { config } from "../config.ts";

/** Replaces {{field}} tokens. Throws on an unknown token rather than
 *  silently mailing someone a literal '{{company}}'. */
export function render(tpl: string, ctx: MergeContext): string {
  return tpl.replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
    if (!(key in ctx)) throw new Error(`Unknown merge field: {{${key}}}`);
    return String(ctx[key as keyof MergeContext] ?? "");
  });
}

/**
 * Who signs a given company's message, most specific first:
 *
 *   1. the per-company override, if one was entered on the company page
 *   2. the student sending it, so a sponsor's reply reaches the person who
 *      actually wrote to them
 *   3. SENDER_NAME from .env
 *
 * Blank and whitespace-only values fall through rather than sending unsigned.
 */
export const senderNameFor = (
  c: Pick<Company, "sender_name">, studentName?: string,
): string =>
  c.sender_name?.trim() || studentName?.trim() || config.canSpam.senderName;

/**
 * How the sender is presented to a recipient: "<who>, <org>".
 *
 * Kept separate from senderNameFor() because the two answer different
 * questions -- senderNameFor decides WHICH PERSON signs (override, then
 * student, then .env), and this decides how that person is displayed. The org
 * is the same for everyone, so folding it into the person's name would mean
 * storing it on every company row and every send.
 */
export const displayNameFor = (
  c: Pick<Company, "sender_name">, studentName?: string,
): string => {
  const who = senderNameFor(c, studentName);
  const org = config.canSpam.senderOrg.trim();
  return org ? `${who}, ${org}` : who;
};

export function contextFor(c: Company, studentName?: string): MergeContext {
  return {
    company: c.name.replace(/\s*\([^)]*\)\s*$/, "").trim(), // drop '(APT)' suffix
    city: c.city ?? "Huntsville",
    state: c.state ?? "AL",
    website: c.website ?? "",
    sender_name: displayNameFor(c, studentName),
  };
}

/**
 * CAN-SPAM footer: the ORGANISATION, its postal address, and how to opt out.
 * Appended to every outbound message -- unconditionally, not per-template --
 * because a real postal address and a working opt-out mechanism are legal
 * minimums for commercial email, not a style choice a template can switch off.
 *
 * The organisation rather than the individual signs it: whoever wrote the
 * message has already signed it in the body, and repeating them here said
 * nothing new. What a recipient cannot get from the body is who the team is,
 * where they are, and how to stop hearing from them.
 *
 * Opt-out mechanism: replying (any reply, or the word UNSUBSCRIBE) reaches the
 * real mailbox in GMAIL_SENDER, since messages are sent from -- and threaded
 * to -- that inbox. A person there records it on the do-not-contact list
 * (`/suppressions`, or the "Do not contact" button on the company page), which
 * blocks every future email, form contact, and ready-list entry for that
 * company. There is no automated inbox scanning -- the Gmail integration is
 * deliberately send-only (see mail/gmail.ts) -- so honoring a request is a
 * manual step a person must do promptly (CAN-SPAM allows up to 10 business
 * days; the suppressions page says so at the point of use).
 */
export function footer(): string {
  const org = config.canSpam.senderOrg.trim() || config.canSpam.senderName;
  const address = config.canSpam.postalAddress;
  return `\n\n---\n${org}${address ? `\n${address}` : ""}\n\n`
    + `If you'd rather not receive future emails from us, just reply to this `
    + `message (e.g. with "UNSUBSCRIBE") and we will honor that within 10 `
    + `business days.`;
}
