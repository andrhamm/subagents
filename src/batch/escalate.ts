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

/**
 * A run the model never saw: the backend died on transport or answered an
 * instant 5xx before any turn completed. Observed live 2026-08-07 — LM
 * Studio under concurrent multi-model load returned 0-0.2s HTTP 500s, and
 * escalating those re-dispatched into the same contention, burning both
 * attempts with no model ever seeing the task. These deserve one same-tier
 * retry after a backoff, not an escalation. The summary prefixes are
 * BackendError's two shapes (backends/base.ts); loop.ts catches on turn 1
 * with no usage recorded, so turns <= 1 and local_tokens === 0 separate
 * "never started" from a mid-run 5xx, and the prefix match separates
 * infrastructure from model-shaped turn-1 errors (e.g. no tool calls).
 */
export function isInfraFailure(e: Envelope): boolean {
  return e.status === "error" && e.local_tokens === 0 && e.turns <= 1 &&
    (/^HTTP 5\d\d:/.test(e.summary) || /^request to .+ failed/.test(e.summary));
}

export interface Attempt {
  envelope: Envelope | null;
  error?: string;
  /** Present on escalated attempts: the tier that ran it. */
  tier?: string;
  /**
   * True on a discarded try that died on infrastructure before any model
   * turn (see isInfraFailure); the attempt after it is its same-tier retry.
   */
  infra_retried?: boolean;
}

export interface JobReport {
  id: string;
  /** In execution order; the escalated attempt, when present, is last. */
  attempts: Attempt[];
  /** The attempt that stands — always the last one, failed or not. */
  final: Attempt;
}

/**
 * A JobResult expands to its standing attempt, preceded — when the
 * scheduler infra-retried — by the discarded try, so the rollup's
 * attempts[] stays a complete execution record.
 */
function toAttempts(r: JobResult, tier?: string): Attempt[] {
  const out: Attempt[] = [];
  if (r.infraFailure) {
    out.push({
      envelope: r.infraFailure.envelope,
      ...(tier === undefined ? {} : { tier }),
      infra_retried: true,
    });
  }
  out.push({
    envelope: r.envelope,
    ...(r.error === undefined ? {} : { error: r.error }),
    ...(tier === undefined ? {} : { tier }),
  });
  return out;
}

/** Fold the escalation pass back onto the first, one report per job. */
export function mergeAttempts(
  first: JobResult[], second: JobResult[], escalatedTier: string,
): JobReport[] {
  const retries = new Map(second.map((r) => [r.id, r]));
  return first.map((r) => {
    const retry = retries.get(r.id);
    const attempts = [
      ...toAttempts(r),
      ...(retry ? toAttempts(retry, escalatedTier) : []),
    ];
    return { id: r.id, attempts, final: attempts[attempts.length - 1]! };
  });
}
