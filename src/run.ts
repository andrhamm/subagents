import { join } from "node:path";
import type { ResolvedRun } from "./config";
import type { LoopOptions } from "./loop";
import { OpenAIBackend } from "./backends/base";
import { hasWriteTools, resolveTools } from "./tools/registry";
import { DEFAULT_SYSTEM_PROMPT, WRITE_SYSTEM_PROMPT_SUFFIX, runLoop } from "./loop";
import { buildEnvelope, type Envelope, type WriteOutcome } from "./envelope";
import { writeTranscript } from "./transcript";
import { assertGitRepo, collectChanges, createWorktree, removeWorktree } from "./worktree";
import { runTestGate } from "./testgate";

export interface RunRequest {
  run: ResolvedRun;
  task: string;
  /** Absolute, existence-checked by the caller. */
  root: string;
  transcriptPath: string;
  deadlineAt?: number;
  apiKey?: string;
  onTurn?: LoopOptions["onTurn"];
}

export interface RunOutcome {
  envelope: Envelope;
  /** True only when the loop finished ok AND the test gate (if any) passed. */
  clean: boolean;
}

/**
 * One complete delegated run: worktree lifecycle, loop, gate, transcript,
 * envelope. Throws only for can't-start conditions (bad tool name, not a
 * git repo); once the loop has run, every failure degrades a field instead.
 */
export async function executeRun(req: RunRequest): Promise<RunOutcome> {
  const { run } = req;
  const tools = resolveTools(run.tools);
  const writes = hasWriteTools(run.tools);

  const started = Date.now();

  let loopRoot = req.root;
  let worktreeDir: string | undefined;
  if (run.worktree) {
    await assertGitRepo(req.root);
    worktreeDir = join(
      process.env["TMPDIR"] ?? "/tmp", `subagents-wt-${started}-${Math.floor(Math.random() * 1e6)}`);
    await createWorktree(req.root, worktreeDir);
    loopRoot = worktreeDir;
  }

  const result = await runLoop({
    backend: new OpenAIBackend(run.baseUrl, req.apiKey),
    model: run.model,
    tools,
    task: req.task,
    maxTurns: run.maxTurns,
    maxTokens: run.maxTokens,
    sampling: run.sampling,
    timeoutMs: run.timeoutMs,
    root: loopRoot,
    ...(writes
      ? { systemPrompt: DEFAULT_SYSTEM_PROMPT + WRITE_SYSTEM_PROMPT_SUFFIX }
      : {}),
    ...(req.deadlineAt === undefined ? {} : { deadlineAt: req.deadlineAt }),
    ...(req.onTurn ? { onTurn: req.onTurn } : {}),
  });

  let writeOutcome: WriteOutcome | undefined;
  let testOutput: string | undefined;
  if (worktreeDir) {
    try {
      const changes = await collectChanges(worktreeDir);
      if (changes.files.length === 0) {
        await removeWorktree(req.root, worktreeDir);
      } else {
        writeOutcome = {
          files: changes.files,
          diffstat: changes.diffstat,
          worktree: worktreeDir,
        };
        if (run.testCmd) {
          // The gate runs after the loop, so it draws from whatever's left of
          // the caller's deadline, not a fresh budget of its own — a 120s
          // default test_timeout_ms inside a 60s --deadline-secs would let
          // the gate blow straight through the promise already made to the
          // caller. Same principle as the per-request clamp in loop.ts; a 1s
          // floor keeps a nearly-exhausted deadline from starving the gate
          // outright.
          const gateTimeoutMs = req.deadlineAt === undefined
            ? run.testTimeoutMs
            : Math.max(1000, Math.min(run.testTimeoutMs, req.deadlineAt - Date.now()));
          const gate = await runTestGate(run.testCmd, worktreeDir, gateTimeoutMs);
          writeOutcome.test = { ran: true, passed: gate.passed, cmd: run.testCmd };
          testOutput = gate.timedOut
            ? `[test gate timed out after ${gateTimeoutMs}ms]\n${gate.output}`
            : gate.output;
        }
      }
    } catch (e) {
      writeOutcome = {
        files: [],
        diffstat:
          `(FAILED to inspect worktree: ${e instanceof Error ? e.message : String(e)})`,
        worktree: worktreeDir,
      };
    }
  }

  let transcriptField = req.transcriptPath;
  try {
    await writeTranscript(req.transcriptPath, {
      model: run.model,
      task: req.task,
      status: result.status,
      messages: result.messages,
      usage: result.usage,
      ...(testOutput !== undefined ? { test_output: testOutput } : {}),
    });
  } catch (e) {
    transcriptField =
      `${req.transcriptPath} (FAILED to write: ${e instanceof Error ? e.message : String(e)})`;
  }

  const envelope = buildEnvelope(result, {
    wallSecs: (Date.now() - started) / 1000,
    transcript: transcriptField,
    contextLimit: null,
    ...(writeOutcome ? { writes: writeOutcome } : {}),
  });

  const gateFailed = writeOutcome?.test !== undefined && !writeOutcome.test.passed;
  return { envelope, clean: result.status === "ok" && !gateFailed };
}
