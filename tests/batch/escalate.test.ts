import { describe, it, expect } from "bun:test";
import type { Envelope } from "../../src/envelope";
import type { JobResult } from "../../src/batch/scheduler";
import { isInfraFailure, mergeAttempts, needsEscalation } from "../../src/batch/escalate";

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

// The envelope shape of a run that died before any model turn: loop.ts
// catches the BackendError on turn 1 and buildEnvelope folds the message
// into `summary` (empty r.summary falls back to detail).
function infraEnv(summary: string): Envelope {
  return env({ status: "error", summary, turns: 1, local_tokens: 0 });
}

describe("isInfraFailure", () => {
  it("recognizes an instant HTTP 5xx with no model turn completed", () => {
    expect(isInfraFailure(infraEnv("HTTP 500: upstream connect error"))).toBe(true);
    expect(isInfraFailure(infraEnv("HTTP 503: loading"))).toBe(true);
  });

  it("recognizes a transport failure — connection refused, timeout", () => {
    expect(isInfraFailure(
      infraEnv("request to http://192.168.1.86:1234/v1 failed: Unable to connect"))).toBe(true);
  });

  it("rejects HTTP 4xx — a wire or config error a retry cannot fix", () => {
    expect(isInfraFailure(infraEnv("HTTP 400: Invalid 'messages'"))).toBe(false);
  });

  it("rejects an error after the model already produced tokens", () => {
    expect(isInfraFailure(env({
      status: "error", summary: "HTTP 500: died mid-run", turns: 3, local_tokens: 900,
    }))).toBe(false);
  });

  it("rejects model-shaped turn-1 errors — capability, not infrastructure", () => {
    expect(isInfraFailure(infraEnv(
      "model 'm' returned no tool calls and no content on turn 1"))).toBe(false);
  });

  it("rejects every non-error status", () => {
    for (const status of ["ok", "max_turns", "budget", "deadline"]) {
      expect(isInfraFailure(env({ status, summary: "HTTP 500: x", local_tokens: 0 })))
        .toBe(false);
    }
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

  it("surfaces a first-pass infra retry as its own attempt, flagged", () => {
    const retried: JobResult = {
      ...res("a", env()),
      infraFailure: {
        envelope: infraEnv("HTTP 500: upstream connect error"),
        startedAt: 0, finishedAt: 1,
      },
    };
    const r = mergeAttempts([retried], [], "")[0]!;
    expect(r.attempts).toHaveLength(2);
    expect(r.attempts[0]!.infra_retried).toBe(true);
    expect(r.attempts[0]!.envelope!.summary).toStartWith("HTTP 500");
    expect(r.attempts[0]!.tier).toBeUndefined();
    expect(r.attempts[1]!.infra_retried).toBeUndefined();
    expect(r.final).toBe(r.attempts[1]!);
    expect(r.final.envelope!.status).toBe("ok");
  });

  it("carries the escalated tier onto an escalation pass's infra attempt", () => {
    const first = [res("a", infraEnv("HTTP 500: x"))];
    const second: JobResult[] = [{
      ...res("a", env({ summary: "recovered" })),
      infraFailure: { envelope: infraEnv("HTTP 503: y"), startedAt: 0, finishedAt: 1 },
    }];
    const r = mergeAttempts(first, second, "strong")[0]!;
    expect(r.attempts).toHaveLength(3);
    expect(r.attempts[0]!.tier).toBeUndefined();
    expect(r.attempts[1]!.infra_retried).toBe(true);
    expect(r.attempts[1]!.tier).toBe("strong");
    expect(r.attempts[2]!.tier).toBe("strong");
    expect(r.final.envelope!.summary).toBe("recovered");
  });
});
