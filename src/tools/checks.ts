import type { CheckConfig } from "../config";
import { runChecks } from "../testgate";
import { markIfCutTail } from "../text";
import type { Tool, ToolContext, ToolResult } from "./types";

export const RUN_CHECKS_NAME = "run_checks";
export const DEFAULT_MAX_CHECK_RUNS = 3;
/** Failure-output tail shown to the model. Small — it re-reads code, not logs. */
const FAIL_TAIL_CHARS = 1500;

/**
 * Per-run factory, never in the static registry: the tool closes over the
 * caller-authored checks and a call counter. Zero arguments by design — the
 * model pulls a trigger the caller loaded; no command text ever crosses the
 * model boundary. The invocation budget stops a churning delegate from
 * spending its deadline re-running a red suite; the post-loop gate remains
 * the authoritative verdict either way.
 */
export function makeRunChecks(
  checks: CheckConfig[],
  timeoutMsPerStage: number,
  deadlineAt?: number,
  maxRuns = DEFAULT_MAX_CHECK_RUNS,
): Tool {
  let runs = 0;
  return {
    name: RUN_CHECKS_NAME,
    schema: {
      type: "function",
      function: {
        name: RUN_CHECKS_NAME,
        description:
          `Run the configured checks in order (${checks.map((c) => c.name).join(" → ")}), ` +
          `stopping at the first failure. No arguments. At most ${maxRuns} calls per run.`,
        parameters: { type: "object", properties: {} },
      },
    },

    async run(_args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
      runs++;
      if (runs > maxRuns) {
        return {
          content:
            `[check budget spent: ${maxRuns} runs used. Finish with what you know — ` +
            "the harness runs the checks once more after you stop.]",
          truncated: false,
        };
      }

      const r = await runChecks(checks, ctx.root, timeoutMsPerStage, deadlineAt);
      const lines = r.stages.map(
        (s) => `${s.name}: ${s.passed ? "PASS" : s.timedOut ? "TIMEOUT" : "FAIL"}`);
      const skipped = checks.length - r.stages.length;
      if (skipped > 0) {
        lines.push(`(${skipped} later stage${skipped === 1 ? "" : "s"} not run — fix the failure first)`);
      }
      const failing = r.stages.find((s) => !s.passed);
      // truncated stays false: the tail cut is marked inline, and the
      // envelope's truncations count means "input coverage was blind",
      // which a shortened check log is not.
      if (!failing) {
        // Defensive: with zero stages `lines` is empty, and joining first
        // would leave a leading blank line before "All checks pass." —
        // config now refuses run_checks with zero stages before a run ever
        // starts, but this stays honest even if that guard is ever bypassed.
        const content = lines.length
          ? `${lines.join("\n")}\nAll checks pass.`
          : "All checks pass.";
        return { content, truncated: false };
      }
      return {
        content:
          `${lines.join("\n")}\n--- ${failing.name} output (tail) ---\n` +
          markIfCutTail(failing.output, FAIL_TAIL_CHARS),
        truncated: false,
      };
    },
  };
}
