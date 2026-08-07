import { describe, it, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Backend } from "../../src/types";
import { runLoop } from "../../src/loop";
import { DEFAULT_MAX_CHECK_RUNS, RUN_CHECKS_NAME, makeRunChecks } from "../../src/tools/checks";

const ctx = () => ({ root: process.cwd() });

describe("makeRunChecks", () => {
  it("reports every green stage and says all pass", async () => {
    const tool = makeRunChecks(
      [{ name: "tests", cmd: "exit 0" }, { name: "style", cmd: "exit 0" }], 5000);
    const r = await tool.run({}, ctx());
    expect(r.content).toContain("tests: PASS");
    expect(r.content).toContain("style: PASS");
    expect(r.content).toContain("All checks pass.");
    expect(r.truncated).toBe(false);
  });

  it("shows the failing stage's output tail and names the skipped stages", async () => {
    const tool = makeRunChecks(
      [
        { name: "tests", cmd: "echo noise; echo 'FAIL: expected 2, got 3'; exit 1" },
        { name: "style", cmd: "exit 0" },
      ],
      5000);
    const r = await tool.run({}, ctx());
    expect(r.content).toContain("tests: FAIL");
    expect(r.content).toContain("FAIL: expected 2, got 3");
    expect(r.content).toContain("(1 later stage not run — fix the failure first)");
    expect(r.content).not.toContain("style: PASS");
  });

  it("keeps the tail of long failure output, marking the front cut", async () => {
    const tool = makeRunChecks(
      [{ name: "tests", cmd: "for i in $(seq 1 500); do echo filler-$i; done; echo LAST-LINE; exit 1" }],
      5000);
    const r = await tool.run({}, ctx());
    expect(r.content).toContain("LAST-LINE");
    expect(r.content).toContain("chars cut from the front");
  });

  it("refuses the call after the budget, telling the model to finish", async () => {
    const tool = makeRunChecks([{ name: "tests", cmd: "exit 0" }], 5000);
    for (let i = 0; i < DEFAULT_MAX_CHECK_RUNS; i++) {
      const r = await tool.run({}, ctx());
      expect(r.content).toContain("All checks pass.");
    }
    const over = await tool.run({}, ctx());
    expect(over.content).toContain("check budget spent");
    expect(over.content).toContain("harness runs the checks once more");
  });

  it("marks a timed-out stage distinctly", async () => {
    const tool = makeRunChecks([{ name: "slow", cmd: "sleep 5" }], 200);
    const r = await tool.run({}, ctx());
    expect(r.content).toContain("slow: TIMEOUT");
  });

  it("runs in the tool context's root — the worktree at runtime", async () => {
    const dir = mkdtempSync(join(tmpdir(), "subagents-rc-"));
    try {
      writeFileSync(join(dir, "flag.txt"), "present\n");
      const tool = makeRunChecks([{ name: "tests", cmd: "grep -q present flag.txt" }], 5000);
      const r = await tool.run({}, { root: dir });
      expect(r.content).toContain("All checks pass.");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("shows the TRUE tail even when the stage output exceeds the stage cap", async () => {
    const tool = makeRunChecks(
      [{ name: "tests", cmd: "for i in $(seq 1 2000); do echo filler-line-$i; done; echo REAL-FINAL-FAILURE-LINE; exit 1" }],
      10_000);
    const r = await tool.run({}, { root: process.cwd() });
    expect(r.content).toContain("REAL-FINAL-FAILURE-LINE");
  });
});

describe("run_checks inside the loop's deadline gate", () => {
  it("counts check time into worstTurnMs — the gate stops a turn it cannot afford", async () => {
    // A backend that always asks for run_checks; the check itself is the
    // slow part. The between-turn gate must learn from the tool-inclusive
    // turn cost and stop, exactly as it does for slow backends.
    let calls = 0;
    const backend: Backend = {
      async chat() {
        calls++;
        return {
          choices: [{
            message: {
              role: "assistant", content: null,
              tool_calls: [{ id: `c${calls}`, function: { name: RUN_CHECKS_NAME, arguments: "{}" } }],
            },
            finish_reason: "tool_calls",
          }],
          usage: { prompt_tokens: 10, completion_tokens: 2 },
        };
      },
    };
    const tool = makeRunChecks([{ name: "slow", cmd: "sleep 0.12" }], 5000, undefined, 50);
    const r = await runLoop({
      backend, model: "m", tools: [tool], task: "t",
      maxTurns: 50, maxTokens: 100, sampling: {}, timeoutMs: 5000, root: process.cwd(),
      deadlineAt: Date.now() + 450, wrapupReserveMs: 50,
    });
    expect(r.status).toBe("deadline");
    expect(r.turns).toBeLessThan(6);
  });
});
