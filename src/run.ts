import { appendFileSync } from "node:fs";
import { join } from "node:path";
import type { ResolvedRun } from "./config";
import type { LoopOptions, TurnEvent } from "./loop";
import { OpenAIBackend } from "./backends/base";
import { hasWriteTools, resolveTools } from "./tools/registry";
import { DEFAULT_SYSTEM_PROMPT, WRITE_SYSTEM_PROMPT_SUFFIX, runLoop } from "./loop";
import { buildEnvelope, type Envelope, type WriteOutcome } from "./envelope";
import { writeTranscript } from "./transcript";
import { assertGitRepo, collectChanges, createWorktree, removeWorktree } from "./worktree";
import { fetchContextLimit, parseContextExceeded } from "./backends/lmstudio";
import { runChecks } from "./testgate";
import { makeRunChecks, RUN_CHECKS_NAME } from "./tools/checks";

export interface RunRequest {
  run: ResolvedRun;
  task: string;
  /** Absolute, existence-checked by the caller. */
  root: string;
  transcriptPath: string;
  deadlineAt?: number;
  apiKey?: string;
  onTurn?: LoopOptions["onTurn"];
  logPath?: string;
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
  // run_checks is a per-run closure, not a registry entry: it must capture
  // THIS run's checks and deadline. The static resolver never sees the name.
  const tools = resolveTools(run.tools.filter((n) => n !== RUN_CHECKS_NAME));
  if (run.tools.includes(RUN_CHECKS_NAME)) {
    tools.push(makeRunChecks(run.checks, run.testTimeoutMs, req.deadlineAt));
  }
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
    ...(req.logPath !== undefined
      ? {
          onEvent: (e: TurnEvent) => {
            // Advisory, like every observer: a full disk must not cost the run.
            try {
              appendFileSync(req.logPath!, `${JSON.stringify({ ts: Date.now(), ...e })}\n`);
            } catch { /* swallowed deliberately */ }
          },
        }
      : {}),
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
        if (run.checks.length > 0) {
          const gate = await runChecks(
            run.checks, worktreeDir, run.testTimeoutMs, req.deadlineAt);
          const failing = gate.stages.find((s) => !s.passed);
          // `test` stays the overall verdict — the batch predicates
          // (rollup clean, needsEscalation) read it and must not care how
          // many stages exist. `checks` carries the per-stage story.
          writeOutcome.test = {
            ran: gate.ran,
            passed: gate.passed,
            cmd: failing?.cmd ?? gate.stages[gate.stages.length - 1]?.cmd ?? run.checks[0]!.cmd,
          };
          writeOutcome.checks = gate.stages.map(
            ({ name, passed, timedOut }) => ({ name, passed, timedOut }));
          testOutput = gate.stages
            .map((s) =>
              `=== ${s.name}: ${s.passed ? "pass" : s.timedOut ? "timeout" : "fail"} ===\n${s.output}`)
            .join("\n");
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

  // Post-loop on purpose: the run itself just (JIT-)loaded the model, so
  // /api/v0 can report loaded_context_length — the config actually serving —
  // where a pre-loop query of an unloaded model would only see the ceiling.
  // Deadline-clamped because this runs inside the wrap-up reserve: a hung
  // management endpoint must degrade the field, never cost the envelope.
  let contextLimit: number | null = null;
  if (run.kind === "lmstudio") {
    const budgetMs = req.deadlineAt === undefined ? Infinity : req.deadlineAt - Date.now();
    if (budgetMs > 2000) {
      contextLimit = await fetchContextLimit(run.baseUrl, run.model, {
        timeoutMs: Math.min(5000, budgetMs - 1500),
      });
    }
  }

  const exceeded = result.status === "error" ? parseContextExceeded(result.detail) : null;
  if (exceeded) {
    // The server itself named the limit it enforced — better than nothing
    // when the management API had no answer (wrong id, endpoint gone).
    contextLimit ??= exceeded.limit;
    // The raw HTTP 400 stays in detail; only the headline is rewritten.
    result.summary = exceeded.needed !== null
      ? `task outgrew the model's context window (${exceeded.needed} tokens needed, ` +
        `${exceeded.limit} available) — retry on a larger-context tier`
      : "task outgrew the model's context window — retry on a larger-context tier";
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
    contextLimit,
    ...(writeOutcome ? { writes: writeOutcome } : {}),
  });

  const gateFailed = writeOutcome?.test !== undefined && !writeOutcome.test.passed;
  return { envelope, clean: result.status === "ok" && !gateFailed };
}
