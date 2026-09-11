// The throttled send queue. This is the component that keeps you out of spam
// folders and keeps you from double-sending.
//
// Every dispatch passes five gates, in order:
//   1. DRY_RUN is off              (must be set explicitly; default is ON)
//   2. CAN-SPAM fields present     (assertSendable throws otherwise)
//   3. address not suppressed      (unsubscribes / bounces / manual DNC)
//   4. company not already contacted
//   5. today's warm-up cap not yet spent
// ...and then the partial unique index in schema.sql catches anything that
// somehow slipped through all five.

import { config, assertSendable } from "../config.ts";
import { db, isSuppressed, alreadyContacted, priorContact, currentCampaign } from "../db.ts";
import { getCompany, emailsFor, getTemplate, addTag } from "../repo.ts";
import { render, contextFor, footer } from "./render.ts";
import { sendMessage } from "./gmail.ts";

/** Daily cap for day N of the campaign, clamped to the ramp's last value. */
export function capForDay(dayIndex: number): number {
  const ramp = config.send.ramp;
  return ramp[Math.min(dayIndex, ramp.length - 1)] ?? 0;
}

/** Randomize the gap +/-40% so the cadence doesn't look machine-generated. */
export function jitteredDelayMs(): number {
  const base = config.send.intervalSeconds * 1000;
  return Math.round(base * (0.6 + Math.random() * 0.8));
}

const today = () => new Date().toISOString().slice(0, 10);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface Budget { day: string; cap: number; used: number }

/**
 * Today's row in send_budget, created on first use. The campaign "day index"
 * is how many days have already been used, so the ramp advances only on days
 * you actually send -- a weekend off doesn't burn ramp steps.
 */
export function todayBudget(): Budget {
  const day = today();
  const existing = db.query<Budget, [string]>(
    `SELECT day, cap, used FROM send_budget WHERE day = ?`).get(day);
  if (existing) return existing;

  const priorDays = db.query<{ n: number }, []>(
    `SELECT COUNT(*) AS n FROM send_budget`).get()?.n ?? 0;
  const cap = capForDay(priorDays);
  db.query(`INSERT INTO send_budget (day, cap, used) VALUES (?, ?, 0)`).run(day, cap);
  return { day, cap, used: 0 };
}

/** Gate 3+4, as a plain list of reasons. Empty means clear to queue. */
export function blockersFor(companyId: number): string[] {
  const out: string[] = [];
  const company = getCompany(companyId);
  if (!company) return ["Company not found."];

  if (company.review_status !== "approved") out.push("Company is not verified (step 2).");
  const primary = emailsFor(companyId).find((e) => e.is_primary === 1);
  if (!primary) out.push("No address selected (step 5).");
  else {
    if (!primary.verified) out.push("Selected address is not verified (step 3).");
    if (isSuppressed(primary.address)) out.push(`${primary.address} is on the suppression list.`);
  }
  if (!company.template_id) out.push("No template selected (step 4).");
  if (alreadyContacted(companyId))
    out.push(`Already queued or sent in campaign "${currentCampaign()}" -- a second send is blocked.`);
  return out;
}

/**
 * Contact in a PREVIOUS campaign. Deliberately not a blocker -- re-messaging a
 * past company about a new event is the point of campaigns. The review UI shows
 * it so the decision is informed rather than accidental.
 */
export function priorContactWarning(companyId: number): string | null {
  const prior = priorContact(companyId);
  return prior
    ? `Contacted before in "${prior.campaign}"${prior.sent_at ? ` on ${prior.sent_at.slice(0, 10)}` : ""}.`
    : null;
}

/** Auto-applied when a message actually goes out, so the history page shows
 *  what was sent and when without anyone having to tag by hand. The rendered
 *  subject goes in the note -- putting it in the tag NAME would mint a new
 *  single-use tag per company, since subjects carry merge fields. */
function tagAsMessaged(companyId: number, campaign: string, subject: string): void {
  try { addTag(companyId, `Messaged: ${campaign}`, "label", subject); }
  catch (err) { console.error(`auto-tag failed for company ${companyId}:`, err); }
}

/**
 * Gate 1-4, then insert a 'queued' row holding the FULLY RENDERED copy, so the
 * log stays truthful even if you edit the template afterwards.
 */
export function enqueue(companyId: number): void {
  assertSendable();                                   // gate 2

  const blockers = blockersFor(companyId);            // gates 3 + 4
  if (blockers.length) throw new Error(blockers.join(" "));

  const company = getCompany(companyId)!;
  const primary = emailsFor(companyId).find((e) => e.is_primary === 1)!;
  const template = getTemplate(company.template_id!);
  if (!template) throw new Error("Selected template no longer exists.");

  const ctx = contextFor(company);
  const subject = render(template.subject, ctx);
  const body = render(template.body, ctx) + footer();

  try {
    db.query(
      `INSERT INTO sends (company_id, email_address, template_id, subject, body,
                          channel, status, campaign)
       VALUES (?, ?, ?, ?, ?, 'gmail', 'queued', ?)`,
    ).run(companyId, primary.address, template.id, subject, body, currentCampaign());
  } catch (err) {
    // The partial unique index is the real guarantee; translate it for the UI.
    if (String(err).includes("UNIQUE constraint failed")) {
      throw new Error(
        `Blocked by the dedup index: this company or address already has a live send in campaign "${currentCampaign()}".`);
    }
    throw err;
  }
}

/** Records an outreach made by hand through a company's own contact form,
 *  so form contacts count against the same dedup guarantee as email. */
export function recordFormSend(companyId: number): void {
  const company = getCompany(companyId);
  if (!company) throw new Error("Company not found.");
  if (alreadyContacted(companyId)) throw new Error("Already queued or sent.");
  const template = company.template_id ? getTemplate(company.template_id) : null;
  const ctx = contextFor(company);
  const subject = template ? render(template.subject, ctx) : "(contact form)";
  db.query(
    `INSERT INTO sends (company_id, email_address, template_id, subject, body,
                        channel, status, sent_at, campaign)
     VALUES (?, ?, ?, ?, ?, 'form', 'sent', datetime('now'), ?)`,
  ).run(
    companyId,
    `form:${company.chamber_slug}`,           // no address exists; keep the row unique
    template?.id ?? null,
    subject,
    template ? render(template.body, ctx) + footer() : "(submitted via company contact form)",
    currentCampaign(),
  );
  tagAsMessaged(companyId, currentCampaign(), subject);
}

export interface DrainReport {
  dryRun: boolean; cap: number; used: number;
  attempted: number; sent: number; failed: number; skipped: number;
  stoppedBecause: string;
}

interface QueuedRow { id: number; company_id: number; email_address: string;
  subject: string; body: string; attempts: number; campaign: string }

/**
 * Drain the queue: one message per jittered interval, stopping at the day's cap.
 * With DRY_RUN on (the default) it reports what it *would* send and changes
 * nothing -- rows stay queued so a real run still picks them up.
 */
export async function drain(
  onProgress?: (r: DrainReport) => void,
): Promise<DrainReport> {
  assertSendable();                                   // gate 2

  const budget = todayBudget();                       // gate 5
  const report: DrainReport = {
    dryRun: config.send.dryRun, cap: budget.cap, used: budget.used,
    attempted: 0, sent: 0, failed: 0, skipped: 0, stoppedBecause: "queue empty",
  };

  const queued = db.query<QueuedRow, []>(
    `SELECT id, company_id, email_address, subject, body, attempts, campaign
     FROM sends WHERE status = 'queued' ORDER BY queued_at`).all();

  for (const row of queued) {
    if (report.used >= budget.cap) {
      report.stoppedBecause = `daily cap reached (${budget.cap})`;
      break;
    }

    // Re-check suppression: it may have been added since this was queued.
    if (isSuppressed(row.email_address)) {
      db.query(`UPDATE sends SET status='skipped', error='suppressed' WHERE id=?`).run(row.id);
      report.skipped++;
      onProgress?.(report);
      continue;
    }

    report.attempted++;

    if (report.dryRun) {                              // gate 1
      console.log(`[DRY_RUN] would send to ${row.email_address}: ${row.subject}`);
      report.sent++;
      report.used++;
      onProgress?.(report);
      continue;                                       // no sleep, no DB change
    }

    try {
      const res = await sendMessage(row.email_address, row.subject, row.body);
      db.query(
        `UPDATE sends SET status='sent', gmail_message_id=?, gmail_thread_id=?,
         sent_at=datetime('now'), attempts=attempts+1, error=NULL WHERE id=?`,
      ).run(res.messageId, res.threadId, row.id);
      db.query(`UPDATE send_budget SET used = used + 1 WHERE day = ?`).run(budget.day);
      tagAsMessaged(row.company_id, row.campaign, row.subject);
      report.sent++;
      report.used++;
    } catch (err) {
      db.query(
        `UPDATE sends SET status='failed', error=?, attempts=attempts+1 WHERE id=?`,
      ).run(String(err instanceof Error ? err.message : err), row.id);
      report.failed++;
    }
    onProgress?.(report);
    await sleep(jitteredDelayMs());
  }

  onProgress?.(report);
  return report;
}

if (import.meta.main) console.log(await drain());
