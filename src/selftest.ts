// Preview (and optionally really send) one message to your own address.
//
// This is the rehearsal for README step 4. It renders through the SAME path a
// real send uses -- contextFor -> render -> footer -> buildRaw -- so what it
// prints is byte-for-byte what Gmail would transmit, headers included.
//
// It deliberately does NOT go through the queue: no company row, no `sends`
// row, no budget consumed, no dedup slot burned. Run it as many times as you
// like. The queue's gates exist to stop you double-contacting real companies,
// which is not what is being tested here.
//
//   bun run test:self                     # preview to TEST_EMAIL
//   bun run test:self someone@else.com    # preview to an explicit address
//   bun run test:self --template 2        # a template other than the first
//   bun run test:self --send              # actually transmit (needs DRY_RUN=0)

import { config, assertSendable } from "./config.ts";
import { render, contextFor, footer } from "./mail/render.ts";
import { buildRaw, sendMessage, isAuthorized } from "./mail/gmail.ts";
import { getTemplate, listTemplates } from "./repo.ts";
import type { Company } from "./types.ts";

/** Stands in for a scraped company, so nothing is written to the database. */
const SAMPLE: Company = {
  id: -1,
  chamber_slug: "self-test",
  name: "Example Robotics, Inc. (ERI)",
  name_key: "example robotics",
  website: "https://example.com",
  phone: null, street: null,
  city: "Huntsville", state: "AL",
  postal_code: null, linkedin: null, category: null,
  template_id: null,
  sender_name: null,
  review_status: "approved",
  scraped_at: "",
};

function parseArgs(argv: string[]) {
  let to = process.env.TEST_EMAIL ?? "";
  let templateId: number | null = null;
  let send = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--send") send = true;
    else if (a === "--template") templateId = Number(argv[++i]);
    else if (a.startsWith("--")) throw new Error(`Unknown flag: ${a}`);
    else to = a;
  }
  return { to, templateId, send };
}

function main(): Promise<void> | void {
  const { to, templateId, send } = parseArgs(process.argv.slice(2));

  if (!to) {
    throw new Error(
      "No recipient. Set TEST_EMAIL in .env, or pass one: bun run test:self you@example.com",
    );
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(to)) {
    throw new Error(`"${to}" is not a valid email address.`);
  }

  // Same gate the real send hits, so a blank CAN-SPAM field fails here first.
  assertSendable();

  const template = templateId !== null
    ? getTemplate(templateId)
    : listTemplates()[0];
  if (!template) {
    throw new Error(templateId !== null
      ? `No template with id ${templateId}. Available: ${listTemplates().map((t) => t.id).join(", ") || "none"}`
      : "No templates exist yet -- create one at /templates.");
  }

  const ctx = contextFor(SAMPLE);
  const subject = render(template.subject, ctx);
  const body = render(template.body, ctx) + (template.include_footer ? footer() : "");
  const raw = buildRaw(to, subject, body);

  console.log(`Template : ${template.name} (id ${template.id})`);
  console.log(`From     : ${config.canSpam.senderName} <${config.gmail.sender}>`);
  console.log(`To       : ${to}`);
  console.log(`Sample   : ${SAMPLE.name} -- merge fields resolve against this\n`);
  console.log("--- headers ".padEnd(72, "-"));
  console.log(raw.slice(0, raw.indexOf("\r\n\r\n")).replace(/\r\n/g, "\n"));
  console.log("--- body ".padEnd(72, "-"));
  console.log(body);
  console.log("".padEnd(72, "-"));

  if (!send) {
    console.log("\nPreview only -- nothing was transmitted and nothing was written.");
    console.log("To really send it:  DRY_RUN=0 in .env, then bun run test:self --send");
    return;
  }

  if (config.send.dryRun) {
    throw new Error("--send refused: DRY_RUN is on. Set DRY_RUN=0 in .env and restart.");
  }
  if (!isAuthorized()) {
    throw new Error("Gmail is not connected. Run `bun run dev` and click “connect Gmail”.");
  }

  return sendMessage(to, subject, body).then((r) => {
    console.log(`\nSent. message ${r.messageId}, thread ${r.threadId}`);
    console.log("Open it and use “Show original”: SPF, DKIM and DMARC should all PASS.");
  });
}

try {
  await main();
} catch (e) {
  console.error(`\n${e instanceof Error ? e.message : e}`);
  process.exit(1);
}
