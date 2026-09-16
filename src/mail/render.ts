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
 * Who signs a given company's message: the per-company override if one was
 * entered, otherwise SENDER_NAME from .env. Blank and whitespace-only overrides
 * fall back rather than sending an unsigned message.
 */
export const senderNameFor = (c: Pick<Company, "sender_name">): string =>
  c.sender_name?.trim() || config.canSpam.senderName;

export function contextFor(c: Company): MergeContext {
  return {
    company: c.name.replace(/\s*\([^)]*\)\s*$/, "").trim(), // drop '(APT)' suffix
    city: c.city ?? "Huntsville",
    state: c.state ?? "AL",
    website: c.website ?? "",
    sender_name: senderNameFor(c),
    unsubscribe: config.canSpam.unsubscribeMailto,
  };
}

/**
 * CAN-SPAM footer. Appended to every outbound body, non-negotiably.
 *
 * `senderName` overrides the signature line only. The postal address and the
 * unsubscribe route stay whatever .env says, because those identify the sending
 * organization and are the part the law is actually about.
 */
export function footer(senderName?: string): string {
  const who = senderName?.trim() || config.canSpam.senderName;
  return `\n\n---\n${who}\n${config.canSpam.postalAddress}\n` +
         `To stop receiving these, reply "unsubscribe" or email ${config.canSpam.unsubscribeMailto}.`;
}
