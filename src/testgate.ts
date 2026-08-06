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
    output: markIfCut(combined, MAX_TEST_OUTPUT_CHARS),
  };
}
