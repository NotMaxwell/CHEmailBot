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

export function contextFor(c: Company): MergeContext {
  return {
    company: c.name.replace(/\s*\([^)]*\)\s*$/, "").trim(), // drop '(APT)' suffix
    city: c.city ?? "Huntsville",
    state: c.state ?? "AL",
    website: c.website ?? "",
    sender_name: config.canSpam.senderName,
    unsubscribe: config.canSpam.unsubscribeMailto,
  };
}

/** CAN-SPAM footer. Appended to every outbound body, non-negotiably. */
export function footer(): string {
  return `\n\n---\n${config.canSpam.senderName}\n${config.canSpam.postalAddress}\n` +
         `To stop receiving these, reply "unsubscribe" or email ${config.canSpam.unsubscribeMailto}.`;
}
