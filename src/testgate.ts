import { markIfCut } from "./text";

/** Cap on captured test output. Marked when cut — it feeds the transcript, not the envelope. */
export const MAX_TEST_OUTPUT_CHARS = 10_000;

export interface TestGateResult {
  ran: true;
  passed: boolean;
  timedOut: boolean;
  cmd: string;
  /** Combined stdout + stderr, mark-if-cut at MAX_TEST_OUTPUT_CHARS. */
  output: string;
}

/**
 * Run the caller's test command in `cwd` (the worktree). Harness-invoked
 * only — deliberately not a model-callable tool. A timeout counts as a
 * failure but is reported distinctly, because the remedy differs: raise
 * test_timeout_ms rather than fix the code.
 */
export async function runTestGate(
  cmd: string, cwd: string, timeoutMs: number,
): Promise<TestGateResult> {
  const proc = Bun.spawn(["sh", "-c", cmd], { cwd, stdout: "pipe", stderr: "pipe" });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, timeoutMs);

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  clearTimeout(timer);

  const combined = `${stdout}${stderr ? `\n${stderr}` : ""}`.trim();
  return {
    ran: true,
    passed: !timedOut && code === 0,
    timedOut,
    cmd,
    output: markIfCut(combined, MAX_TEST_OUTPUT_CHARS),
  };
}
