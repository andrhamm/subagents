import { describe, it, expect } from "bun:test";
import type { Envelope } from "../../src/envelope";
import type { JobResult } from "../../src/batch/scheduler";
import type { JobReport } from "../../src/batch/escalate";
import { buildRollup } from "../../src/batch/rollup";

function env(overrides: Partial<Envelope> = {}): Envelope {
  return {
    status: "ok", summary: "s", turns: 1, wall_secs: 0.1,
    context: { peak_prompt_tokens: 1, limit: null, pressure: null },
    truncations: 0, local_tokens: 100, transcript: "/t.json",
    ...overrides,
  };
}

function report(id: string, envelope: Envelope | null, error?: string): JobReport {
  const attempt = { envelope, ...(error === undefined ? {} : { error }) };
  return { id, attempts: [attempt], final: attempt };
}

function timing(id: string, startedAt: number, finishedAt: number, envelope: Envelope | null = env()): JobResult {
  return { id, envelope, queuedAt: 0, startedAt, finishedAt };
}

const base = { notRun: [], configured: 2, wallSecs: 60, transcriptDir: "/tmp/batch" };

describe("buildRollup status", () => {
  it("is ok when every final finished ok and everything ran", () => {
    const r = buildRollup({ ...base, reports: [report("a", env())], timings: [timing("a", 0, 1000)] });
    expect(r.status).toBe("ok");
  });

  it("is partial when some jobs finished ok and others did not", () => {
    const r = buildRollup({
      ...base,
      reports: [report("a", env()), report("b", env({ status: "error" }))],
      timings: [timing("a", 0, 1000), timing("b", 0, 1000)],
    });
    expect(r.status).toBe("partial");
  });

  it("is partial when jobs never ran, even if the rest are clean", () => {
    const r = buildRollup({
      ...base, notRun: ["c"],
      reports: [report("a", env())], timings: [timing("a", 0, 1000)],
    });
    expect(r.status).toBe("partial");
    expect(r.not_run).toEqual(["c"]);
  });

  it("is partial, not ok, when a status-ok envelope's test gate failed", () => {
    const failedGate = env({
      test: { ran: true, passed: false, cmd: "bun test" },
    });
    const r = buildRollup({
      ...base,
      reports: [report("a", env()), report("b", failedGate)],
      timings: [timing("a", 0, 1000), timing("b", 0, 1000, failedGate)],
    });
    expect(r.status).toBe("partial");
  });

  it("is error when nothing finished ok", () => {
    const r = buildRollup({
      ...base,
      reports: [report("a", null, "refused"), report("b", env({ status: "deadline" }))],
      timings: [timing("a", 0, 1000, null), timing("b", 0, 1000, env({ status: "deadline" }))],
    });
    expect(r.status).toBe("error");
  });
});

describe("buildRollup evidence", () => {
  it("computes throughput, latency percentiles, and queue wait from timings", () => {
    const r = buildRollup({
      ...base,
      reports: [report("a", env()), report("b", env()), report("c", env())],
      timings: [
        timing("a", 200, 5_200),   // 5.0s latency, 0.2s wait
        timing("b", 400, 8_400),   // 8.0s latency, 0.4s wait
        timing("c", 600, 12_600),  // 12.0s latency, 0.6s wait
      ],
    });
    expect(r.concurrency.configured).toBe(2);
    expect(r.concurrency.achieved_throughput_per_min).toBe(3); // 3 jobs / 60s
    expect(r.concurrency.latency_p50_secs).toBe(8);
    expect(r.concurrency.latency_max_secs).toBe(12);
    expect(r.concurrency.queue_wait_secs).toBe(0.4); // mean of 0.2/0.4/0.6
  });

  it("counts timeouts and errors distinctly — their remedies differ", () => {
    const r = buildRollup({
      ...base,
      reports: [
        report("a", env({ status: "deadline" })),
        report("b", null, "refused"),
        report("c", env()),
      ],
      timings: [
        timing("a", 0, 1000, env({ status: "deadline" })),
        timing("b", 0, 1000, null),
        timing("c", 0, 1000),
      ],
    });
    expect(r.concurrency.timeouts).toBe(1);
    expect(r.concurrency.errors).toBe(1);
  });

  it("sums local_tokens across every attempt, escalations included", () => {
    const twoAttempts: JobReport = {
      id: "a",
      attempts: [
        { envelope: env({ status: "error", local_tokens: 300 }) },
        { envelope: env({ local_tokens: 700 }), tier: "strong" },
      ],
      final: { envelope: env({ local_tokens: 700 }), tier: "strong" },
    };
    const r = buildRollup({
      ...base, reports: [twoAttempts], timings: [timing("a", 0, 1000)],
    });
    expect(r.local_tokens).toBe(1000);
  });

  it("survives an empty batch outcome without NaN", () => {
    const r = buildRollup({ ...base, reports: [], timings: [], notRun: ["a", "b"] });
    expect(r.concurrency.latency_p50_secs).toBe(0);
    expect(r.concurrency.achieved_throughput_per_min).toBe(0);
    expect(Number.isNaN(r.concurrency.queue_wait_secs)).toBe(false);
  });
});
