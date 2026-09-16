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
import { db, isSuppressed, alreadyContacted, priorContact, currentCampaign,
         companySuppression } from "../db.ts";
import { getCompany, emailsFor, addTag, resolveTemplateFor } from "../repo.ts";
import { render, contextFor, footer, senderNameFor } from "./render.ts";
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
 * Today's budget, computed WITHOUT writing anything.
 *
 * This used to insert today's row on first call, and the dashboard called it on
 * every page view -- so merely looking at the app advanced the warm-up ramp
 * with nothing sent. The day index is now the number of PRIOR days that
 * actually sent something, and only recordUsage() writes a row.
 */
export function peekBudget(): Budget {
  const day = today();
  const priorDays = db.query<{ n: number }, [string]>(
    `SELECT COUNT(*) AS n FROM send_budget WHERE day < ? AND used > 0`).get(day)?.n ?? 0;
  const used = db.query<{ used: number }, [string]>(
    `SELECT used FROM send_budget WHERE day = ?`).get(day)?.used ?? 0;
  return { day, cap: capForDay(priorDays), used };
}

function recordUsage(day: string, cap: number): void {
  db.query(`INSERT INTO send_budget (day, cap, used) VALUES (?, ?, 1)
            ON CONFLICT(day) DO UPDATE SET used = used + 1`).run(day, cap);
}

/**
 * Rows a drain claimed but never finished: the process died between handing
 * the message to Gmail and recording the result. It MAY have been delivered,
 * so sending it again automatically could double-send -- the one thing this
 * tool must never do. Fail it with an instruction instead; `failed` falls out
 * of the dedup index, so a person who checks the Sent folder can re-queue it.
 * Ten minutes far exceeds one attempt (Gmail calls time out at 30s), so a drain
 * that is still running is never disturbed.
 */
export function recoverInterrupted(): number {
  return db.query(
    `UPDATE sends SET status = 'failed',
       error = 'Interrupted mid-send -- check your Gmail Sent folder before re-queueing.'
     WHERE status = 'queued' AND attempted_at IS NOT NULL
       AND attempted_at < datetime('now', '-10 minutes')`).run().changes;
}

/** Gate 3+4, as a plain list of reasons. Empty means clear to queue. */
export function blockersFor(companyId: number): string[] {
  const out: string[] = [];
  const company = getCompany(companyId);
  if (!company) return ["Company not found."];

  if (company.review_status !== "approved") out.push("Company is not verified (step 2).");
  const primary = emailsFor(companyId).find((e) => e.is_primary === 1);
  if (!primary) out.push("No address selected (step 5).");
  else if (!primary.verified) out.push("Selected address is not verified (step 3).");
  const suppressed = companySuppression(companyId);
  if (suppressed) out.push(suppressed);
  if (!resolveTemplateFor(company))
    out.push("No template selected (step 4), and this campaign has no default.");
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
function tagAsMessaged(
  companyId: number, campaign: string, subject: string, student?: Sender,
): void {
  try {
    addTag(companyId, `Messaged: ${campaign}`, "label", subject);
    // Who worked this company. A tag per student rather than a note, so the
    // history page's existing tag filter answers "what did Alice send?"
    // without a new report.
    if (student) addTag(companyId, `Student: ${student.name}`, "label");
  } catch (err) { console.error(`auto-tag failed for company ${companyId}:`, err); }
}

/** The signed-in account a send is attributed to. */
export interface Sender { id: number; name: string }

/**
 * Gate 1-4, then insert a 'queued' row holding the FULLY RENDERED copy, so the
 * log stays truthful even if you edit the template afterwards.
 */
export function enqueue(companyId: number, student?: Sender): void {
  assertSendable();                                   // gate 2

  const blockers = blockersFor(companyId);            // gates 3 + 4
  if (blockers.length) throw new Error(blockers.join(" "));

  const company = getCompany(companyId)!;
  const primary = emailsFor(companyId).find((e) => e.is_primary === 1)!;
  // May be the company's own choice or the campaign default -- blockersFor has
  // already established that one of them resolves.
  const template = resolveTemplateFor(company)!.template;

  // The postal address is only required by templates that actually print it.
  if (template.include_footer && !config.canSpam.postalAddress) {
    throw new Error(
      `Refusing to send: "${template.name}" appends the footer, but SENDER_POSTAL_ADDRESS ` +
      `is not set in .env. Fill it in, or untick "Append the footer" on that template.`);
  }

  const ctx = contextFor(company, student?.name);
  const who = senderNameFor(company, student?.name);
  const subject = render(template.subject, ctx);
  const body = render(template.body, ctx) + (template.include_footer ? footer() : "");

  try {
    db.query(
      `INSERT INTO sends (company_id, email_address, template_id, subject, body,
                          channel, status, campaign, sender_name, student_id)
       VALUES (?, ?, ?, ?, ?, 'gmail', 'queued', ?, ?, ?)`,
    ).run(companyId, primary.address, template.id, subject, body, currentCampaign(),
          who, student?.id ?? null);
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
export function recordFormSend(companyId: number, student?: Sender): void {
  const company = getCompany(companyId);
  if (!company) throw new Error("Company not found.");
  if (alreadyContacted(companyId)) throw new Error("Already queued or sent.");
  const suppressed = companySuppression(companyId);   // an opt-out covers forms too
  if (suppressed) throw new Error(suppressed);
  const template = resolveTemplateFor(company)?.template ?? null;
  const ctx = contextFor(company, student?.name);
  const subject = template ? render(template.subject, ctx) : "(contact form)";
  db.query(
    `INSERT INTO sends (company_id, email_address, template_id, subject, body,
                        channel, status, sent_at, campaign, sender_name, student_id)
     VALUES (?, ?, ?, ?, ?, 'form', 'sent', datetime('now'), ?, ?, ?)`,
  ).run(
    companyId,
    `form:${company.chamber_slug}`,           // no address exists; keep the row unique
    template?.id ?? null,
    subject,
    template ? render(template.body, ctx) + (template.include_footer ? footer() : "")
             : "(submitted via company contact form)",
    currentCampaign(),
    senderNameFor(company, student?.name),
    student?.id ?? null,
  );
  tagAsMessaged(companyId, currentCampaign(), subject, student);
}

export interface DrainReport {
  dryRun: boolean; cap: number; used: number;
  attempted: number; sent: number; failed: number; skipped: number;
  stoppedBecause: string;
}

interface QueuedRow { id: number; company_id: number; email_address: string;
  subject: string; body: string; attempts: number; campaign: string;
  sender_name: string | null;
  /** Who queued it. Joined in so the send tag names them without a second read. */
  student_id: number | null; student_name: string | null }

/**
 * Drain the queue: one message per jittered interval, stopping at the day's cap.
 * With DRY_RUN on (the default) it reports what it *would* send and changes
 * nothing -- rows stay queued so a real run still picks them up.
 */
export async function drain(
  onProgress?: (r: DrainReport) => void,
): Promise<DrainReport> {
  assertSendable();                                   // gate 2

  recoverInterrupted();
  const budget = peekBudget();                        // gate 5
  const report: DrainReport = {
    dryRun: config.send.dryRun, cap: budget.cap, used: budget.used,
    attempted: 0, sent: 0, failed: 0, skipped: 0, stoppedBecause: "queue empty",
  };

  const queued = db.query<QueuedRow, []>(
    `SELECT s.id, s.company_id, s.email_address, s.subject, s.body, s.attempts,
            s.campaign, s.sender_name, s.student_id, st.name AS student_name
     FROM sends s LEFT JOIN students st ON st.id = s.student_id
     WHERE s.status = 'queued' AND s.attempted_at IS NULL
     ORDER BY s.queued_at`).all();

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

    // Claim BEFORE calling Gmail. Two drains cannot both claim a row, and a row
    // claimed by a process that then died is failed by recoverInterrupted()
    // rather than picked up and sent a second time.
    const claimed = db.query(
      `UPDATE sends SET attempted_at = datetime('now'), attempts = attempts + 1
       WHERE id = ? AND status = 'queued' AND attempted_at IS NULL`).run(row.id);
    if (claimed.changes !== 1) continue;

    try {
      const res = await sendMessage(row.email_address, row.subject, row.body,
                                    row.sender_name ?? undefined);
      db.query(
        `UPDATE sends SET status='sent', gmail_message_id=?, gmail_thread_id=?,
         sent_at=datetime('now'), error=NULL WHERE id=?`,
      ).run(res.messageId, res.threadId, row.id);
      recordUsage(budget.day, budget.cap);
      tagAsMessaged(row.company_id, row.campaign, row.subject,
                    row.student_id && row.student_name
                      ? { id: row.student_id, name: row.student_name } : undefined);
      report.sent++;
      report.used++;
    } catch (err) {
      db.query(
        `UPDATE sends SET status='failed', error=? WHERE id=?`,
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
