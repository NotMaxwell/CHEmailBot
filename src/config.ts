// Central config. Everything reads from here, never from process.env directly,
// so the guardrails below are impossible to bypass by accident.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** Project root, from this file's location -- never process.cwd(). */
export const ROOT = dirname(import.meta.dir);

/**
 * Bun auto-loads .env from the WORKING DIRECTORY only. Started from anywhere
 * else, the project's .env was silently skipped -- no CAN-SPAM fields, no Gmail
 * config. Load the root .env explicitly. Keys already set win, so real
 * environment variables (and the test preload) still take precedence.
 */
function loadRootEnv(path: string): void {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    if (/^\s*(#|$)/.test(line)) continue;
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m || process.env[m[1]!] !== undefined) continue;
    process.env[m[1]!] = m[2]!.replace(/^(['"])(.*)\1$/, "$2");
  }
}
loadRootEnv(join(ROOT, ".env"));

export const VERSION: string =
  JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;

const env = (k: string, fallback = "") => process.env[k] ?? fallback;

export const config = {
  port: Number(env("PORT", "3000")),
  /** Loopback by default. There is no login: binding to every interface put
   *  the whole company database -- and the send queue -- on the local network. */
  host: env("HOST", "127.0.0.1"),
  dbPath: env("DB_PATH", "data/chembot.db"),

  gmail: {
    clientId: env("GMAIL_CLIENT_ID"),
    clientSecret: env("GMAIL_CLIENT_SECRET"),
    redirectUri: env("GMAIL_REDIRECT_URI", "http://localhost:3000/oauth/callback"),
    sender: env("GMAIL_SENDER"),
    // Inside data/ so it survives a container rebuild along with the database.
    tokenPath: join(ROOT, env("GMAIL_TOKEN_PATH", "data/.gmail-token.json")),
  },

  send: {
    /** Daily caps by day-of-campaign. Past the end, the last value repeats. */
    ramp: env("SEND_RAMP", "5,10,15,20,30,40,50").split(",").map(Number),
    intervalSeconds: Number(env("SEND_INTERVAL_SECONDS", "180")),
    /** Defaults to TRUE. Sending requires an explicit DRY_RUN=0. */
    dryRun: env("DRY_RUN", "1") !== "0",
  },

  // Sender identity, appended to every outbound body as the footer. Named for
  // the regime it was built against; this outreach is a sponsorship
  // solicitation rather than commercial advertising, so it carries no opt-out
  // line -- see footer() and the do-not-contact list.
  canSpam: {
    senderName: env("SENDER_NAME"),
    /** Appended to whoever signs, as "<name>, <org>". Blank = name alone. */
    senderOrg: env("SENDER_ORG"),
    postalAddress: env("SENDER_POSTAL_ADDRESS"),
  },

  scrape: {
    delayMs: Number(env("SCRAPE_DELAY_MS", "2000")),
    userAgent: env("SCRAPE_USER_AGENT", `CHEmailBot/${VERSION}`),
    /** A hung connection must not freeze a scrape (and the single job lock). */
    timeoutMs: Number(env("SCRAPE_TIMEOUT_MS", "30000")),
    chamberBase: "https://cm.hsvchamber.org",
    /** Verified against the live directory. robots.txt permits /list/category/*. */
    techCategories: [
      "computers-it-web-1439",
      "consulting-information-technology-2560",
      "engineering-electronics-technical-2233",
      "technology-r-d-4568",
    ],
  },
} as const;

/**
 * Throws unless the message can name who sent it. SENDER_NAME is always used
 * -- it is the From display name and the signature -- so it is required
 * unconditionally.
 *
 * SENDER_POSTAL_ADDRESS is checked separately, at the point a message that
 * actually carries the footer is built (see enqueue), because a template with
 * the footer switched off never uses it.
 */
export function assertSendable(): void {
  if (!config.canSpam.senderName) {
    throw new Error("Refusing to send: missing sender identity in .env -> senderName");
  }
}
