import { describe, it, expect } from "bun:test";
import type { Envelope } from "../../src/envelope";
import type { JobResult } from "../../src/batch/scheduler";
import { mergeAttempts, needsEscalation } from "../../src/batch/escalate";

function env(overrides: Partial<Envelope> = {}): Envelope {
  return {
    status: "ok", summary: "s", turns: 1, wall_secs: 0.1,
    context: { peak_prompt_tokens: 1, limit: null, pressure: null },
    truncations: 0, local_tokens: 2, transcript: "/t.json",
    ...overrides,
  };
}

function res(id: string, envelope: Envelope | null, error?: string): JobResult {
  return {
    id, envelope, ...(error === undefined ? {} : { error }),
    queuedAt: 0, startedAt: 1, finishedAt: 2,
  };
}

describe("needsEscalation", () => {
  it("passes a clean ok result through", () => {
    expect(needsEscalation(res("a", env()))).toBe(false);
  });

  it("escalates every non-ok status", () => {
    for (const status of ["max_turns", "budget", "deadline", "error"]) {
      expect(needsEscalation(res("a", env({ status })))).toBe(true);
    }
  });

  it("escalates an ok result that worked blind — truncations are unsafe coverage", () => {
    expect(needsEscalation(res("a", env({ truncations: 2 })))).toBe(true);
  });

  it("escalates a job whose runner threw", () => {
    expect(needsEscalation(res("a", null, "connection refused"))).toBe(true);
  });

  it("escalates an ok-status envelope whose test gate failed", () => {
    expect(needsEscalation(res("a", env({
      test: { ran: true, passed: false, cmd: "bun test" },
    })))).toBe(true);
  });
});

describe("mergeAttempts", () => {
  it("keeps single-attempt jobs as-is and stacks retried ones", () => {
    const first = [res("clean", env()), res("flaky", env({ status: "error" }))];
    const second = [res("flaky", env({ summary: "better" }))];
    const reports = mergeAttempts(first, second, "strong");

    const clean = reports.find((r) => r.id === "clean")!;
    expect(clean.attempts).toHaveLength(1);
    expect(clean.final.envelope!.status).toBe("ok");

    const flaky = reports.find((r) => r.id === "flaky")!;
    expect(flaky.attempts).toHaveLength(2);
    expect(flaky.attempts[1]!.tier).toBe("strong");
    expect(flaky.final.envelope!.summary).toBe("better");
  });

  it("keeps the second attempt as final even when it also failed — honesty over optimism", () => {
    const first = [res("stuck", env({ status: "error" }))];
    const second = [res("stuck", null, "still refused")];
    const r = mergeAttempts(first, second, "strong")[0]!;
    expect(r.final.envelope).toBeNull();
    expect(r.final.error).toBe("still refused");
  });
});
