import type { Envelope } from "../envelope";
import type { ResolvedJob } from "./jobs";

export interface JobResult {
  id: string;
  /** null when runJob threw; `error` says why. */
  envelope: Envelope | null;
  error?: string;
  queuedAt: number;
  startedAt: number;
  finishedAt: number;
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
  runJob(job: ResolvedJob): Promise<Envelope>;
  /**
   * Advisory progress callback (drives the --progress file). Not awaited:
   * a slow observer must not slow the batch, and a torn read of the
   * progress file costs the poller one re-poll, not correctness.
   */
  onUpdate?(state: BatchState): void;
}

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
    o.onUpdate?.({
      total: o.jobs.length,
      done: [...done],
      running: [...running],
      pending: o.jobs
        .filter((j) => !started.has(j.id) && !notRun.includes(j.id))
        .map((j) => j.id),
      not_run: [...notRun],
    });
  };

  for (const group of groups.values()) {
    const queue = [...group];
    const width = Math.min(Math.max(1, group[0]!.run.maxInFlight), group.length);
    const worker = async (): Promise<void> => {
      for (;;) {
        const job = queue.shift();
        if (!job) return;
        started.add(job.id);
        running.add(job.id);
        const startedAt = Date.now();
        emit();
        let env: Envelope | null = null;
        let error: string | undefined;
        try {
          env = await o.runJob(job);
        } catch (e) {
          error = e instanceof Error ? e.message : String(e);
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
        });
        emit();
      }
    };
    await Promise.all(Array.from({ length: width }, () => worker()));
  }

  emit();
  return { results, notRun };
}
