// Central config. Everything reads from here, never from process.env directly,
// so the guardrails below are impossible to bypass by accident.

const env = (k: string, fallback = "") => process.env[k] ?? fallback;

export const config = {
  port: Number(env("PORT", "3000")),
  dbPath: env("DB_PATH", "data/chembot.db"),

  gmail: {
    clientId: env("GMAIL_CLIENT_ID"),
    clientSecret: env("GMAIL_CLIENT_SECRET"),
    redirectUri: env("GMAIL_REDIRECT_URI", "http://localhost:3000/oauth/callback"),
    sender: env("GMAIL_SENDER"),
    tokenPath: ".gmail-token.json",
  },

  send: {
    /** Daily caps by day-of-campaign. Past the end, the last value repeats. */
    ramp: env("SEND_RAMP", "5,10,15,20,30,40,50").split(",").map(Number),
    intervalSeconds: Number(env("SEND_INTERVAL_SECONDS", "180")),
    /** Defaults to TRUE. Sending requires an explicit DRY_RUN=0. */
    dryRun: env("DRY_RUN", "1") !== "0",
  },

  canSpam: {
    senderName: env("SENDER_NAME"),
    postalAddress: env("SENDER_POSTAL_ADDRESS"),
    unsubscribeMailto: env("UNSUBSCRIBE_MAILTO"),
  },

  scrape: {
    delayMs: Number(env("SCRAPE_DELAY_MS", "2000")),
    userAgent: env("SCRAPE_USER_AGENT", "CHEmailBot/0.1"),
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

/** Throws unless every legally-required CAN-SPAM field is populated. */
export function assertSendable(): void {
  const missing = (["senderName", "postalAddress", "unsubscribeMailto"] as const)
    .filter((k) => !config.canSpam[k]);
  if (missing.length) {
    throw new Error(
      `Refusing to send: missing CAN-SPAM fields in .env -> ${missing.join(", ")}`,
    );
  }
}
