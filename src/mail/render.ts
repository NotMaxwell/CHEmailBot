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

export function contextFor(c: Company, studentName?: string): MergeContext {
  return {
    company: c.name.replace(/\s*\([^)]*\)\s*$/, "").trim(), // drop '(APT)' suffix
    city: c.city ?? "Huntsville",
    state: c.state ?? "AL",
    website: c.website ?? "",
    sender_name: senderNameFor(c, studentName),
  };
}

/**
 * Identity footer, appended to every outbound body.
 *
 * Sender name and a real postal address only. This outreach is a sponsorship
 * solicitation rather than commercial advertising, so it carries no opt-out
 * line; opt-outs are handled by the do-not-contact list, which blocks a company
 * at send time whether the request arrived by reply, phone, or in person.
 *
 * `senderName` overrides the signature line only -- the postal address
 * identifies the sending organization and never varies per recipient.
 */
export function footer(senderName?: string): string {
  const who = senderName?.trim() || config.canSpam.senderName;
  return `\n\n---\n${who}\n${config.canSpam.postalAddress}`;
}
