import { describe, it, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_TEST_OUTPUT_CHARS, runChecks } from "../src/testgate";

describe("runChecks single-stage (backward compat)", () => {
  it("reports a passing command", async () => {
    const r = await runChecks([{ name: "tests", cmd: "exit 0" }], process.cwd(), 5000);
    expect(r).toMatchObject({ ran: true, passed: true, stages: [
      { name: "tests", passed: true, timedOut: false, cmd: "exit 0" }
    ] });
  });

  it("reports a failing command and captures both output streams", async () => {
    const r = await runChecks([{ name: "tests", cmd: "echo out; echo err 1>&2; exit 1" }], process.cwd(), 5000);
    expect(r.stages[0]!.passed).toBe(false);
    expect(r.stages[0]!.timedOut).toBe(false);
    expect(r.stages[0]!.output).toContain("out");
    expect(r.stages[0]!.output).toContain("err");
  });

  it("runs in the given cwd", async () => {
    const dir = mkdtempSync(join(tmpdir(), "subagents-gate-"));
    try {
      const r = await runChecks([{ name: "tests", cmd: "pwd" }], dir, 5000);
      // macOS tmpdir realpath prefix differs (/private/var vs /var); match the leaf.
      expect(r.stages[0]!.output).toContain(dir.split("/").pop()!);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("kills an overrunning command and says so", async () => {
    const r = await runChecks([{ name: "tests", cmd: "sleep 5" }], process.cwd(), 200);
    expect(r.stages[0]!.timedOut).toBe(true);
    expect(r.stages[0]!.passed).toBe(false);
  });

  it("caps captured output with an explicit marker, never silently", async () => {
    const r = await runChecks(
      [{ name: "tests", cmd: `head -c ${MAX_TEST_OUTPUT_CHARS + 5000} /dev/zero | tr '\\0' 'x'` }],
      process.cwd(), 5000,
    );
    expect(r.stages[0]!.output.length).toBeLessThanOrEqual(MAX_TEST_OUTPUT_CHARS + 1);
    expect(r.stages[0]!.output.endsWith("…")).toBe(true);
  });

  it("returns within the budget even when the command backgrounds a grandchild", async () => {
    const started = Date.now();
    const r = await runChecks([{ name: "tests", cmd: "( sleep 6 & ) ; echo parent-done; exit 0" }], process.cwd(), 300);
    expect(Date.now() - started).toBeLessThan(3000);
    expect(r.stages[0]!.timedOut).toBe(true);
    expect(r.stages[0]!.passed).toBe(false);
  });

  it("kills a command that traps SIGTERM", async () => {
    const started = Date.now();
    const r = await runChecks([{ name: "tests", cmd: "trap '' TERM; sleep 6" }], process.cwd(), 300);
    expect(Date.now() - started).toBeLessThan(3000);
    expect(r.stages[0]!.timedOut).toBe(true);
  });
});

describe("runChecks staging", () => {
  it("runs stages in order and stops at the first failure", async () => {
    const r = await runChecks(
      [
        { name: "tests", cmd: "exit 1" },
        { name: "style", cmd: "echo should-not-run" },
      ],
      process.cwd(), 5000,
    );
    expect(r.passed).toBe(false);
    expect(r.stages).toHaveLength(1);
    expect(r.stages[0]!.name).toBe("tests");
  });

  it("runs the style stage only after tests pass", async () => {
    const r = await runChecks(
      [
        { name: "tests", cmd: "exit 0" },
        { name: "style", cmd: "echo lint-ran; exit 1" },
      ],
      process.cwd(), 5000,
    );
    expect(r.passed).toBe(false);
    expect(r.stages.map((s) => s.name)).toEqual(["tests", "style"]);
    expect(r.stages[1]!.output).toContain("lint-ran");
  });

  it("reports all-green with every stage", async () => {
    const r = await runChecks(
      [{ name: "tests", cmd: "exit 0" }, { name: "style", cmd: "exit 0" }],
      process.cwd(), 5000,
    );
    expect(r.passed).toBe(true);
    expect(r.stages).toHaveLength(2);
    expect(r.ran).toBe(true);
  });

  it("reports an empty pipeline as ran: false, passed: true", async () => {
    const r = await runChecks([], process.cwd(), 5000);
    expect(r).toEqual({ ran: false, passed: true, stages: [] });
  });

  it("clamps each stage to the remaining deadline", async () => {
    const started = Date.now();
    const r = await runChecks(
      [{ name: "slow", cmd: "sleep 5" }],
      process.cwd(), 120_000, Date.now() + 1200,
    );
    expect(Date.now() - started).toBeLessThan(4000);
    expect(r.stages[0]!.timedOut).toBe(true);
    expect(r.passed).toBe(false);
  });
});
