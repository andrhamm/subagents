import type { JobReport } from "./escalate";
import type { JobResult } from "./scheduler";

export interface ConcurrencyEvidence {
  configured: number;
  achieved_throughput_per_min: number;
  latency_p50_secs: number;
  latency_max_secs: number;
  queue_wait_secs: number;
  /** Jobs whose final envelope stopped at the deadline. */
  timeouts: number;
  /** Jobs that errored — thrown runner, unreadable response, or status "error". */
  errors: number;
}

export interface Rollup {
  status: "ok" | "partial" | "error";
  jobs: JobReport[];
  not_run: string[];
  concurrency: ConcurrencyEvidence;
  wall_secs: number;
  local_tokens: number;
  transcript_dir: string;
}

const round = (n: number, places: number): number => {
  const f = 10 ** places;
  return Math.round(n * f) / f;
};

/** Lower median — stable, and indifferent to a one-element tail. */
const p50 = (sorted: number[]): number =>
  sorted.length === 0 ? 0 : sorted[Math.floor((sorted.length - 1) / 2)]!;

/**
 * The evidence block exists because the throughput ceiling is a property of
 * host × model × prompt shape, not knowable in advance: the harness reports
 * what happened at the configured level, and the caller tunes
 * max_in_flight. A widening p50→max spread with flat throughput is queueing,
 * not parallelism; rising queue_wait says the same thing.
 */
export function buildRollup(o: {
  reports: JobReport[];
  /** Every attempt's timing, escalation pass included. */
  timings: JobResult[];
  notRun: string[];
  configured: number;
  wallSecs: number;
  transcriptDir: string;
}): Rollup {
  const clean = (r: JobReport): boolean =>
    r.final.envelope !== null && r.final.envelope.status === "ok";
  const allClean = o.reports.every(clean) && o.notRun.length === 0;
  const noneClean = o.reports.length > 0 && !o.reports.some(clean);
  const status = allClean ? "ok" : noneClean ? "error" : "partial";

  const latencies = o.timings
    .map((t) => (t.finishedAt - t.startedAt) / 1000)
    .sort((a, b) => a - b);
  const waits = o.timings.map((t) => (t.startedAt - t.queuedAt) / 1000);
  const meanWait = waits.length
    ? waits.reduce((sum, w) => sum + w, 0) / waits.length
    : 0;

  return {
    status,
    jobs: o.reports,
    not_run: o.notRun,
    concurrency: {
      configured: o.configured,
      achieved_throughput_per_min:
        o.wallSecs > 0 ? round(o.timings.length / (o.wallSecs / 60), 1) : 0,
      latency_p50_secs: round(p50(latencies), 1),
      latency_max_secs: round(latencies[latencies.length - 1] ?? 0, 1),
      queue_wait_secs: round(meanWait, 1),
      timeouts: o.reports.filter((r) => r.final.envelope?.status === "deadline").length,
      errors: o.reports.filter(
        (r) => r.final.error !== undefined || r.final.envelope === null ||
          r.final.envelope.status === "error",
      ).length,
    },
    wall_secs: round(o.wallSecs, 1),
    local_tokens: o.reports.reduce(
      (sum, r) => sum + r.attempts.reduce(
        (s, a) => s + (a.envelope?.local_tokens ?? 0), 0), 0),
    transcript_dir: o.transcriptDir,
  };
}
