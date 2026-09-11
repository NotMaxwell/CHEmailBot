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
import { db, isSuppressed, alreadyContacted } from "../db.ts";

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

/** TODO: insert a 'queued' row; surfaces the dedup violation as a clean error. */
export function enqueue(_companyId: number): void {
  throw new Error("not implemented");
}

/** TODO: drain the queue, one message per jitteredDelayMs, honoring the cap. */
export async function drain(): Promise<void> {
  assertSendable();
  void db; void isSuppressed; void alreadyContacted;
  throw new Error("not implemented");
}
