import { describe, it, expect } from "bun:test";
import type { Envelope } from "../../src/envelope";
import type { Fixture } from "../../src/bench/fixture";
import { scoreEnvelope } from "../../src/bench/score";

function env(overrides: Partial<Envelope> = {}): Envelope {
  return {
    status: "ok", summary: "lines 9, 10 and 12 validate", turns: 2, wall_secs: 8,
    context: { peak_prompt_tokens: 1000, limit: null, pressure: null },
    truncations: 0, local_tokens: 2000, transcript: "/t.json",
    ...overrides,
  };
}

function fx(oracle: Fixture["oracle"]): Fixture {
  return { name: "f", dir: "/f", task: "t", tools: ["read_file"], checks: [], oracle };
}

describe("scoreEnvelope", () => {
  it("passes a clean match", () => {
    const r = scoreEnvelope(
      fx({ status: "ok", summary_must_match: ["\\b9\\b", "\\b12\\b"] }), env());
    expect(r).toEqual({ pass: true, failures: [] });
  });

  it("fails on status mismatch, naming expected and got", () => {
    const r = scoreEnvelope(fx({ status: "ok" }), env({ status: "deadline" }));
    expect(r.pass).toBe(false);
    expect(r.failures[0]).toMatch(/status.*ok.*deadline/);
  });

  it("fails on a missing citation, naming the regex", () => {
    const r = scoreEnvelope(fx({ summary_must_match: ["\\b99\\b"] }), env());
    expect(r.pass).toBe(false);
    expect(r.failures[0]).toContain("\\b99\\b");
  });

  it("fails on a fabrication-trap hit", () => {
    const r = scoreEnvelope(
      fx({ summary_must_not_match: ["\\b10\\b"] }), env());
    expect(r.pass).toBe(false);
    expect(r.failures[0]).toMatch(/must_not_match/);
  });

  it("checks the gate verdict when the oracle demands it", () => {
    const failed = env({ test: { ran: true, passed: false, cmd: "x" } });
    const r = scoreEnvelope(fx({ checks_pass: true }), failed);
    expect(r.pass).toBe(false);
    const ok = env({ test: { ran: true, passed: true, cmd: "x" } });
    expect(scoreEnvelope(fx({ checks_pass: true }), ok).pass).toBe(true);
  });

  it("compares files_changed order-insensitively", () => {
    const e = env({ files_changed: ["b.ts", "a.ts"] });
    expect(scoreEnvelope(fx({ files_changed: ["a.ts", "b.ts"] }), e).pass).toBe(true);
    expect(scoreEnvelope(fx({ files_changed: ["a.ts"] }), e).pass).toBe(false);
  });

  it("collects every failure, not just the first", () => {
    const r = scoreEnvelope(
      fx({ status: "ok", summary_must_match: ["\\b99\\b"], checks_pass: true }),
      env({ status: "error", summary: "nope" }));
    expect(r.failures.length).toBeGreaterThanOrEqual(3);
  });
});
