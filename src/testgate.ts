import type { CheckConfig } from "./config";
import { markIfCutTail } from "./text";

/** Cap on captured test output, tail-keeping — it feeds the transcript and the in-loop tail display.
 *  Failures print at the end, so a tail of a tail is still the true tail. */
export const MAX_TEST_OUTPUT_CHARS = 10_000;

export interface StageResult {
  name: string;
  passed: boolean;
  timedOut: boolean;
  cmd: string;
  /** Combined stdout+stderr, tail-kept at MAX_TEST_OUTPUT_CHARS (failures print at the end). */
  output: string;
}

export interface ChecksResult {
  /** False only for an empty pipeline — nothing ran, nothing to fail. */
  ran: boolean;
  passed: boolean;
  /** Stages actually executed, in order. Stops after the first failure. */
  stages: StageResult[];
}

interface TestGateResult {
  ran: true;
  passed: boolean;
  timedOut: boolean;
  cmd: string;
  /** Combined stdout + stderr, tail-kept at MAX_TEST_OUTPUT_CHARS (failures print at the end). */
  output: string;
}

/**
 * Run a single stage command in `cwd`. Private per-stage primitive spawned
 * by runChecks. A timeout counts as a failure but is reported distinctly,
 * because the remedy differs: raise timeoutMs rather than fix the code.
 */
async function runStage(
  cmd: string, cwd: string, timeoutMs: number,
): Promise<TestGateResult> {
  const proc = Bun.spawn(["sh", "-c", cmd], { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  let timedOut = false;
  const outReader = proc.stdout.getReader();
  const errReader = proc.stderr.getReader();
  const timer = setTimeout(() => {
    timedOut = true;
    // SIGKILL: a gate command that traps SIGTERM would survive a polite kill.
    proc.kill(9);
    // Stop waiting on the pipes too: a backgrounded grandchild inherits them
    // and would otherwise hold the read open past the deadline.
    void outReader.cancel().catch(() => {});
    void errReader.cancel().catch(() => {});
  }, timeoutMs);

  const drain = async (reader: ReadableStreamDefaultReader<Uint8Array> | NodeJS.ReadableStream): Promise<string> => {
    const decoder = new TextDecoder();
    let text = "";
    try {
      for (;;) {
        const { done, value } = await (reader as ReadableStreamDefaultReader<Uint8Array>).read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
      }
    } catch {
      // A cancelled reader ends the loop; whatever was captured stands.
    }
    return text;
  };

  const [stdout, stderr] = await Promise.all([drain(outReader as any), drain(errReader as any)]);
  const code = await proc.exited;
  clearTimeout(timer);

  const combined = `${stdout}${stderr ? `\n${stderr}` : ""}`.trim();
  return {
    ran: true,
    passed: !timedOut && code === 0,
    timedOut,
    cmd,
    output: markIfCutTail(combined, MAX_TEST_OUTPUT_CHARS),
  };
}

/**
 * Run the caller's ordered checks in `cwd`, stopping at the first failure —
 * "lint only after tests pass" is stage order, not logic, and the failing
 * stage's output is the delegate's coaching. Each stage clamps to the
 * remaining deadline (floor 1s), same promise the loop keeps per request.
 */
export async function runChecks(
  checks: CheckConfig[], cwd: string, timeoutMsPerStage: number, deadlineAt?: number,
): Promise<ChecksResult> {
  const stages: StageResult[] = [];
  for (const check of checks) {
    let budget = timeoutMsPerStage;
    if (deadlineAt !== undefined) {
      budget = Math.max(1000, Math.min(budget, deadlineAt - Date.now()));
    }
    const r = await runStage(check.cmd, cwd, budget);
    stages.push({
      name: check.name, passed: r.passed, timedOut: r.timedOut, cmd: check.cmd,
      output: r.output,
    });
    if (!r.passed) return { ran: true, passed: false, stages };
  }
  return { ran: checks.length > 0, passed: true, stages };
}
