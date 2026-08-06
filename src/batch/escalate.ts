import type { Envelope } from "../envelope";
import type { JobResult } from "./scheduler";

/**
 * A job worth a second, stronger attempt: it failed outright, stopped
 * early, completed while working blind (truncations > 0 — its coverage
 * claims are unsafe, per the skill's trust rules), or completed but left a
 * broken test gate behind — a status "ok" envelope doesn't mean the edit
 * is usable when the caller configured a gate to check exactly that.
 */
export function needsEscalation(r: JobResult): boolean {
  if (r.error !== undefined || r.envelope === null) return true;
  return r.envelope.status !== "ok" || r.envelope.truncations > 0 ||
    r.envelope.test?.passed === false;
}

export interface Attempt {
  envelope: Envelope | null;
  error?: string;
  /** Present on escalated attempts: the tier that ran it. */
  tier?: string;
}

export interface JobReport {
  id: string;
  /** In execution order; the escalated attempt, when present, is last. */
  attempts: Attempt[];
  /** The attempt that stands — always the last one, failed or not. */
  final: Attempt;
}

function toAttempt(r: JobResult, tier?: string): Attempt {
  return {
    envelope: r.envelope,
    ...(r.error === undefined ? {} : { error: r.error }),
    ...(tier === undefined ? {} : { tier }),
  };
}

/** Fold the escalation pass back onto the first, one report per job. */
export function mergeAttempts(
  first: JobResult[], second: JobResult[], escalatedTier: string,
): JobReport[] {
  const retries = new Map(second.map((r) => [r.id, r]));
  return first.map((r) => {
    const retry = retries.get(r.id);
    const attempts = [toAttempt(r)];
    if (retry) attempts.push(toAttempt(retry, escalatedTier));
    return { id: r.id, attempts, final: attempts[attempts.length - 1]! };
  });
}
