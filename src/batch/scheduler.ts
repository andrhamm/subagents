import type { Envelope } from "../envelope";
import type { ResolvedJob } from "./jobs";
import { isInfraFailure } from "./escalate";

/** The discarded try behind an infra retry — kept, never silently dropped. */
export interface InfraFailure {
  /** Always status "error" with a transport/5xx summary (see isInfraFailure). */
  envelope: Envelope;
  startedAt: number;
  finishedAt: number;
}

export interface JobResult {
  id: string;
  /** null when runJob threw; `error` says why. */
  envelope: Envelope | null;
  error?: string;
  queuedAt: number;
  startedAt: number;
  finishedAt: number;
  /**
   * Present when the first try died on infrastructure before any model turn
   * and the scheduler retried once at the same tier: the discarded try.
   * This result is that retry — timings cover the retry alone.
   */
  infraFailure?: InfraFailure;
}

export interface BatchState {
  total: number;
  done: string[];
  running: string[];
  pending: string[];
  not_run: string[];
}

export interface ScheduleOptions {
  jobs: ResolvedJob[];
  /** `attempt` is 0 for the first try, 1 for the one infra retry. */
  runJob(job: ResolvedJob, attempt: number): Promise<Envelope>;
  /**
   * Advisory progress callback (drives the --progress file). Not awaited:
   * a slow observer must not slow the batch, and a torn read of the
   * progress file costs the poller one re-poll, not correctness.
   */
  onUpdate?(state: BatchState): void;
  /**
   * Absolute epoch-ms budget. Gates STARTS only: a running job finishes and
   * keeps its envelope; jobs never started land in `notRun` — named, not
   * silently dropped. The single-run deadline machinery handles in-flight
   * overruns; the batch's job is to stop feeding the queue.
   */
  deadlineAt?: number;
  /** Time reserved to assemble the rollup. */
  reserveMs?: number;
  /**
   * Wait before the single same-tier retry of a job whose run died on
   * infrastructure (transport/HTTP-5xx before any model turn — see
   * isInfraFailure). The wait is the point: an instant re-dispatch lands in
   * the same contention that produced the failure. The sleeping worker
   * deliberately holds its concurrency slot, easing that contention.
   */
  infraRetryBackoffMs?: number;
}

export const DEFAULT_BATCH_RESERVE_MS = 2000;
export const DEFAULT_INFRA_RETRY_BACKOFF_MS = 3000;

export interface ScheduleResult {
  results: JobResult[];
  notRun: string[];
}

/**
 * Groups run sequentially by (provider, model) in first-seen order — each
 * model loads exactly once, the design's scheduling invariant, encoded here
 * rather than remembered by an operator. Within a group, at most
 * `max_in_flight` jobs run concurrently. A failing job becomes a JobResult
 * with `error`; it never takes the batch down.
 */
export async function schedule(o: ScheduleOptions): Promise<ScheduleResult> {
  const queuedAt = Date.now();

  const groups = new Map<string, ResolvedJob[]>();
  for (const j of o.jobs) {
    const key = `${j.run.provider}:${j.run.model}`;
    const list = groups.get(key) ?? [];
    list.push(j);
    groups.set(key, list);
  }

  const results: JobResult[] = [];
  const notRun: string[] = [];
  const running = new Set<string>();
  const done: string[] = [];
  const started = new Set<string>();

  const emit = (): void => {
    try {
      o.onUpdate?.({
        total: o.jobs.length,
        done: [...done],
        running: [...running],
        pending: o.jobs
          .filter((j) => !started.has(j.id) && !notRun.includes(j.id))
          .map((j) => j.id),
        not_run: [...notRun],
      });
    } catch {
      // advisory observer must not take down the batch
    }
  };

  for (const group of groups.values()) {
    if (
      o.deadlineAt !== undefined &&
      Date.now() + (o.reserveMs ?? DEFAULT_BATCH_RESERVE_MS) >= o.deadlineAt
    ) {
      for (const j of group) notRun.push(j.id);
      continue;
    }
    const queue = [...group];
    const width = Math.min(Math.max(1, group[0]!.run.maxInFlight), group.length);
    const worker = async (): Promise<void> => {
      for (;;) {
        if (
          o.deadlineAt !== undefined &&
          Date.now() + (o.reserveMs ?? DEFAULT_BATCH_RESERVE_MS) >= o.deadlineAt
        ) {
          for (const j of queue.splice(0)) notRun.push(j.id);
          emit();
          return;
        }
        const job = queue.shift();
        if (!job) return;
        started.add(job.id);
        running.add(job.id);
        let startedAt = Date.now();
        emit();
        let env: Envelope | null = null;
        let error: string | undefined;
        try {
          env = await o.runJob(job, 0);
        } catch (e) {
          error = e instanceof Error ? e.message : String(e);
        }
        // One same-tier retry when the model never saw the task — an infra
        // failure retried here is not a failure escalation should pay for.
        // Bounded to one, and only when the deadline can afford the backoff
        // plus the rollup reserve; past that the failure stands as today.
        let infraFailure: InfraFailure | undefined;
        const backoff = o.infraRetryBackoffMs ?? DEFAULT_INFRA_RETRY_BACKOFF_MS;
        if (
          env !== null && isInfraFailure(env) &&
          (o.deadlineAt === undefined ||
            Date.now() + backoff + (o.reserveMs ?? DEFAULT_BATCH_RESERVE_MS) < o.deadlineAt)
        ) {
          infraFailure = { envelope: env, startedAt, finishedAt: Date.now() };
          await Bun.sleep(backoff);
          startedAt = Date.now();
          env = null;
          try {
            env = await o.runJob(job, 1);
          } catch (e) {
            error = e instanceof Error ? e.message : String(e);
          }
        }
        running.delete(job.id);
        done.push(job.id);
        results.push({
          id: job.id,
          envelope: env,
          ...(error === undefined ? {} : { error }),
          queuedAt,
          startedAt,
          finishedAt: Date.now(),
          ...(infraFailure === undefined ? {} : { infraFailure }),
        });
        emit();
      }
    };
    await Promise.all(Array.from({ length: width }, () => worker()));
  }

  emit();
  return { results, notRun };
}
