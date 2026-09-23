// Central config. Everything reads from here, never from process.env directly,
// so the guardrails below are impossible to bypass by accident.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

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

/** Set by Render for every web service, e.g. "https://chemailbot.onrender.com". */
const RENDER_URL = env("RENDER_EXTERNAL_URL");

export const config = {
  port: Number(env("PORT", "3000")),
  /** Loopback by default. There is no login: binding to every interface put
   *  the whole company database -- and the send queue -- on the local network. */
  host: env("HOST", "127.0.0.1"),
  dbPath: env("DB_PATH", "data/chembot.db"),

  gmail: {
    clientId: env("GMAIL_CLIENT_ID"),
    clientSecret: env("GMAIL_CLIENT_SECRET"),
    /**
     * Where Google sends the browser back. Must match a redirect URI on the
     * OAuth client character for character. Render publishes the service's own
     * public URL as RENDER_EXTERNAL_URL, so a deploy there derives this itself
     * and there is one less value to paste in two places and get wrong.
     */
    redirectUri: env("GMAIL_REDIRECT_URI", RENDER_URL
      ? `${RENDER_URL.replace(/\/$/, "")}/oauth/callback`
      : "http://localhost:3000/oauth/callback"),
    sender: env("GMAIL_SENDER"),
    // Beside the database by default, so it survives a container rebuild along
    // with it. resolve(), not join(): a host running this off a mounted disk
    // gives an ABSOLUTE path, and join() would have pasted it onto ROOT.
    tokenPath: resolve(ROOT, env("GMAIL_TOKEN_PATH", "data/.gmail-token.json")),
  },

  /**
   * Shared code required to create an account, or "" for open sign-up.
   *
   * Blank is the original behaviour and the right one on the loopback bind or a
   * home LAN, where reaching the app already means you are on the team's
   * network. Set it the moment the app is reachable from the open internet:
   * without it, whoever finds the URL gets an account, the whole sponsor list,
   * and a send button pointed at the team's Gmail.
   */
  signupCode: env("SIGNUP_CODE"),

  send: {
    /** Daily caps by day-of-campaign. Past the end, the last value repeats. */
    ramp: env("SEND_RAMP", "5,10,15,20,30,40,50").split(",").map(Number),
    intervalSeconds: Number(env("SEND_INTERVAL_SECONDS", "180")),
    /** Defaults to TRUE. Sending requires an explicit DRY_RUN=0. */
    dryRun: env("DRY_RUN", "1") !== "0",
  },

  // Sender identity, appended to every outbound body as the footer: who the
  // organisation is, where it is, and how to opt out. Every field here is a
  // CAN-SPAM requirement, not a style choice -- see footer() in mail/render.ts.
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
    /**
     * Verified against the live directory (125 categories total). robots.txt
     * permits /list/category/*. Added 2026-09-22, checked by member count:
     * aerospace-defense-government-contractors (308 -- Redstone Arsenal's
     * footprint on the directory) and manufacturing-industry (100 --
     * fabrication/machine shops, a natural fit for build-season sponsors).
     */
    techCategories: [
      "computers-it-web-1439",
      "consulting-information-technology-2560",
      "engineering-electronics-technical-2233",
      "technology-r-d-4568",
      "aerospace-defense-government-contractors-2067",
      "manufacturing-industry-475",
    ],
  },
} as const;

/**
 * Throws unless the message can meet CAN-SPAM's baseline: who sent it and
 * where they can be reached by post. Every outbound message carries the
 * footer (see mail/render.ts#footer) with no per-template opt-out, so both
 * fields are required unconditionally rather than only when a template
 * happens to use them.
 */
export function assertSendable(): void {
  if (!config.canSpam.senderName) {
    throw new Error("Refusing to send: missing sender identity in .env -> senderName");
  }
  if (!config.canSpam.postalAddress) {
    throw new Error("Refusing to send: missing SENDER_POSTAL_ADDRESS in .env -- CAN-SPAM requires a real postal address in every message.");
  }
}
