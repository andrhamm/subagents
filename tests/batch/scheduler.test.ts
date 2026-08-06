import { describe, it, expect } from "bun:test";
import type { Envelope } from "../../src/envelope";
import type { ResolvedJob } from "../../src/batch/jobs";
import { schedule, type BatchState } from "../../src/batch/scheduler";

/** A ResolvedJob with just the fields the scheduler reads. */
function job(id: string, model: string, maxInFlight = 1): ResolvedJob {
  return {
    id,
    spec: { id, profile: "p", task: "t" },
    root: "/",
    run: {
      baseUrl: "http://x/v1", kind: "openai", model, sampling: {}, tools: [],
      maxTurns: 1, maxTokens: 1, timeoutMs: 1000, worktree: false,
      testTimeoutMs: 1000, provider: "local", maxInFlight,
    },
  };
}

function envelope(id: string): Envelope {
  return {
    status: "ok", summary: id, turns: 1, wall_secs: 0.1,
    context: { peak_prompt_tokens: 1, limit: null, pressure: null },
    truncations: 0, local_tokens: 2, transcript: `/t/${id}.json`,
  };
}

describe("schedule", () => {
  it("runs groups sequentially by (provider, model), in first-seen order", async () => {
    const started: string[] = [];
    const { results } = await schedule({
      jobs: [job("a1", "m1"), job("b1", "m2"), job("a2", "m1")],
      runJob: async (j) => {
        started.push(j.id);
        await Bun.sleep(10);
        return envelope(j.id);
      },
    });
    // m1's group (a1, a2) drains before m2's begins — the model loads once.
    expect(started).toEqual(["a1", "a2", "b1"]);
    expect(results).toHaveLength(3);
  });

  it("caps in-group concurrency at max_in_flight", async () => {
    let inFlight = 0;
    let peak = 0;
    await schedule({
      jobs: [job("a", "m", 2), job("b", "m", 2), job("c", "m", 2), job("d", "m", 2)],
      runJob: async (j) => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await Bun.sleep(20);
        inFlight--;
        return envelope(j.id);
      },
    });
    expect(peak).toBe(2);
  });

  it("turns a throwing job into a result, not a crash", async () => {
    const { results } = await schedule({
      jobs: [job("ok1", "m"), job("boom", "m"), job("ok2", "m")],
      runJob: async (j) => {
        if (j.id === "boom") throw new Error("connection refused");
        return envelope(j.id);
      },
    });
    const boom = results.find((r) => r.id === "boom")!;
    expect(boom.envelope).toBeNull();
    expect(boom.error).toContain("connection refused");
    expect(results.filter((r) => r.envelope !== null)).toHaveLength(2);
  });

  it("records queued/started/finished timestamps in order", async () => {
    const { results } = await schedule({
      jobs: [job("a", "m")],
      runJob: async () => {
        await Bun.sleep(15);
        return envelope("a");
      },
    });
    const r = results[0]!;
    expect(r.queuedAt).toBeLessThanOrEqual(r.startedAt);
    expect(r.startedAt).toBeLessThan(r.finishedAt);
    expect(r.finishedAt - r.startedAt).toBeGreaterThanOrEqual(10);
  });

  it("reports state transitions through onUpdate", async () => {
    const states: BatchState[] = [];
    await schedule({
      jobs: [job("a", "m"), job("b", "m")],
      runJob: async (j) => {
        await Bun.sleep(5);
        return envelope(j.id);
      },
      onUpdate: (s) => states.push(structuredClone(s)),
    });
    expect(states.some((s) => s.running.includes("a") && s.pending.includes("b"))).toBe(true);
    const last = states[states.length - 1]!;
    expect(last.done.sort()).toEqual(["a", "b"]);
    expect(last.running).toEqual([]);
    expect(last.pending).toEqual([]);
  });
});
