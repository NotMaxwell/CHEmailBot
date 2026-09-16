// Gmail adapter over plain fetch -- no googleapis dependency (~50MB avoided).
// Mail leaves your real mailbox, so replies thread naturally.
//
// Scope: gmail.send only. It CANNOT read your inbox, which is the scope you
// want to grant a script like this.
//
// Bootstrap: GET /oauth/start -> Google consent -> GET /oauth/callback.
// The refresh token is persisted to config.gmail.tokenPath (gitignored).

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { config } from "../config.ts";

const SCOPE = "https://www.googleapis.com/auth/gmail.send";
const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const SEND_ENDPOINT = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";

interface StoredToken {
  access_token: string;
  refresh_token: string;
  /** epoch ms */
  expires_at: number;
}

export interface SendResult { messageId: string; threadId: string }

function readToken(): StoredToken | null {
  if (!existsSync(config.gmail.tokenPath)) return null;
  try { return JSON.parse(readFileSync(config.gmail.tokenPath, "utf8")); }
  catch { return null; }
}

function writeToken(t: StoredToken): void {
  writeFileSync(config.gmail.tokenPath, JSON.stringify(t, null, 2), { mode: 0o600 });
}

export const isAuthorized = (): boolean => readToken() !== null;

/** `state` must be echoed back by Google and checked in the callback. */
export function authUrl(state: string): string {
  const { clientId, redirectUri } = config.gmail;
  if (!clientId) throw new Error("GMAIL_CLIENT_ID is not set in .env");
  return `${AUTH_ENDPOINT}?` + new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: SCOPE,
    access_type: "offline",   // we need a refresh token
    prompt: "consent",        // force one even on re-authorization
    state,
  });
}

async function tokenRequest(params: Record<string, string>): Promise<any> {
  const res = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    signal: AbortSignal.timeout(30_000),
    body: new URLSearchParams({
      client_id: config.gmail.clientId,
      client_secret: config.gmail.clientSecret,
      ...params,
    }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`Google token error: ${json.error_description ?? json.error ?? res.status}`);
  return json;
}

/** Completes the OAuth dance. Called by /oauth/callback. */
export async function exchangeCode(code: string): Promise<void> {
  const t = await tokenRequest({
    code,
    redirect_uri: config.gmail.redirectUri,
    grant_type: "authorization_code",
  });
  if (!t.refresh_token) {
    throw new Error("Google returned no refresh_token. Revoke the app's access and retry.");
  }
  writeToken({
    access_token: t.access_token,
    refresh_token: t.refresh_token,
    expires_at: Date.now() + t.expires_in * 1000,
  });
}

/** Returns a live access token, refreshing 60s before expiry. */
async function accessToken(): Promise<string> {
  const stored = readToken();
  if (!stored) throw new Error("Gmail is not authorized yet -- visit /oauth/start");
  if (Date.now() < stored.expires_at - 60_000) return stored.access_token;

  const t = await tokenRequest({
    refresh_token: stored.refresh_token,
    grant_type: "refresh_token",
  });
  const refreshed: StoredToken = {
    access_token: t.access_token,
    refresh_token: stored.refresh_token,   // Google omits it on refresh
    expires_at: Date.now() + t.expires_in * 1000,
  };
  writeToken(refreshed);
  return refreshed.access_token;
}

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");
const b64url = (s: string) =>
  b64(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** RFC 2047 encodes a header value only when it needs it. */
const encodeHeader = (v: string) =>
  /^[\x20-\x7E]*$/.test(v) ? v : `=?UTF-8?B?${b64(v)}?=`;

/** Builds an RFC 2822 message. Body is base64 so long lines and UTF-8 are safe. */
export function buildRaw(
  to: string, subject: string, body: string, fromName?: string,
): string {
  // The address is always the authorized mailbox; only the display name varies,
  // so the From line matches whoever signed the body.
  const who = fromName?.trim() || config.canSpam.senderName;
  const from = who ? `${encodeHeader(who)} <${config.gmail.sender}>` : config.gmail.sender;

  const headers = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${encodeHeader(subject)}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    // Deliverability: gives Gmail/Outlook a native unsubscribe affordance.
    ...(config.canSpam.unsubscribeMailto
      ? [`List-Unsubscribe: <mailto:${config.canSpam.unsubscribeMailto}>`] : []),
  ];
  // base64 bodies must be wrapped at 76 chars per RFC 2045.
  const encoded = b64(body).replace(/(.{76})/g, "$1\r\n").trimEnd();
  return `${headers.join("\r\n")}\r\n\r\n${encoded}`;
}

export async function sendMessage(
  to: string, subject: string, body: string, fromName?: string,
): Promise<SendResult> {
  const token = await accessToken();
  const res = await fetch(SEND_ENDPOINT, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    signal: AbortSignal.timeout(30_000),   // recoverInterrupted() relies on a bound
    body: JSON.stringify({ raw: b64url(buildRaw(to, subject, body, fromName)) }),
  });
  const json = await res.json();
  if (!res.ok) {
    throw new Error(`Gmail send failed (${res.status}): ${json?.error?.message ?? "unknown"}`);
  }
  return { messageId: json.id, threadId: json.threadId };
}
