import { describe, it, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_TEST_OUTPUT_CHARS, runTestGate } from "../src/testgate";

describe("runTestGate", () => {
  it("reports a passing command", async () => {
    const r = await runTestGate("exit 0", process.cwd(), 5000);
    expect(r).toMatchObject({ ran: true, passed: true, timedOut: false, cmd: "exit 0" });
  });

  it("reports a failing command and captures both output streams", async () => {
    const r = await runTestGate("echo out; echo err 1>&2; exit 1", process.cwd(), 5000);
    expect(r.passed).toBe(false);
    expect(r.timedOut).toBe(false);
    expect(r.output).toContain("out");
    expect(r.output).toContain("err");
  });

  it("runs in the given cwd", async () => {
    const dir = mkdtempSync(join(tmpdir(), "subagents-gate-"));
    try {
      const r = await runTestGate("pwd", dir, 5000);
      // macOS tmpdir realpath prefix differs (/private/var vs /var); match the leaf.
      expect(r.output).toContain(dir.split("/").pop()!);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("kills an overrunning command and says so", async () => {
    const r = await runTestGate("sleep 5", process.cwd(), 200);
    expect(r.timedOut).toBe(true);
    expect(r.passed).toBe(false);
  });

  it("caps captured output with an explicit marker, never silently", async () => {
    const r = await runTestGate(
      `head -c ${MAX_TEST_OUTPUT_CHARS + 5000} /dev/zero | tr '\\0' 'x'`,
      process.cwd(), 5000,
    );
    expect(r.output.length).toBeLessThanOrEqual(MAX_TEST_OUTPUT_CHARS + 1);
    expect(r.output.endsWith("…")).toBe(true);
  });
});
