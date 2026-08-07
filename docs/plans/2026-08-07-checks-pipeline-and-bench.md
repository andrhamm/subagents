# subagents Checks Pipeline & Benchmark Suite — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Phase A — in-loop validation for delegates: an ordered `checks` pipeline (tests, then style — stop at first failure), a `run_checks` tool so the delegate sees red/green mid-loop without bash, per-job check overrides for TDD-style batches, and instant syntax feedback riding on every edit. Phase B — a first-class benchmark suite: committed read-loop fixtures with deterministic oracles, an Exercism importer for standardized write-loop tasks at scale, per-turn debug logging, and a `subagents bench` command that scores any tier against a baseline.

**Architecture:** Phase A generalizes the single `test_cmd` gate into an ordered stage list resolved by config, executed by a stop-at-first-failure runner that both the post-loop gate and a new model-callable `run_checks` tool share. The tool is a per-run closure (config-authored commands only — the model pulls triggers, never writes command text). Phase B reuses `executeRun` in-process: a fixture is a directory copied into a throwaway git repo, a task, and an oracle; the runner scores envelopes against oracles and diffs results against a committed baseline. The loop gains a structured per-turn event stream that serves both bench runs and real workloads.

**Tech Stack:** Bun 1.3+, TypeScript (no build step), `bun:test`, the `git` CLI. Zero runtime dependencies.

## Global Constraints

- **Zero runtime dependencies.** `devDependencies` may contain only `@types/bun` and `typescript`. `Bun.YAML`, `Bun.spawn`, `Bun.Transpiler`, global `fetch`.
- **The model never authors command text.** Every executable string comes from caller-authored config (`checks[].cmd`); `run_checks` takes no arguments. This is the standing bash-deferral, restated as the design rule that makes in-loop validation safe.
- **Ordered checks stop at the first failure.** "Don't lint until tests pass" is encoded by stage order, never by conditional logic. The failure output IS the coaching.
- **Never truncate silently.** Check output shown to the model is tail-biased (failures print at the end) and carries an explicit marker naming what was cut from the front.
- **The post-loop gate stays authoritative.** `run_checks` informs the delegate; the harness re-runs the pipeline after the loop and only that verdict reaches the envelope. The model cannot claim green.
- **Never overrun the caller's deadline.** Each check stage clamps to the remaining budget exactly as the current gate does (floor 1s); `run_checks` execution time counts into the loop's `worstTurnMs` like any tool.
- **Back-compat:** `test_cmd` remains valid config — sugar for `checks: [{name: tests, cmd: <test_cmd>}]`. The envelope keeps `test` as the overall verdict (batch predicates in `rollup.ts`/`escalate.ts` stay untouched); a new `checks` array carries per-stage detail.
- **Bench measures the harness, not the model.** Public exercises are contaminated; only relative deltas across harness variants are claimed. The bench README says so.
- **Bench fixtures from Exercism are generated, validated, and gitignored — never vendored.** The importer proves each oracle by running the exercise's canonical solution and skips what fails.
- **Once a run starts, a valid envelope always reaches stdout.** Unchanged; new post-loop stages degrade fields honestly.
- Runtime verified in repo: Bun 1.3.14. License MIT. **Do not add a git remote or push.**

---

# Phase A — checks pipeline and in-loop validation (Tasks 1–7)

### Task 1: Config — ordered `checks`, `test_cmd` desugar, per-job overrides

**Files:**
- Modify: `src/config.ts`
- Modify: `src/batch/jobs.ts`
- Test: `tests/config.test.ts` (append)
- Test: `tests/batch/jobs.test.ts` (append)

**Interfaces:**
- Consumes: existing `ProfileConfig`, `ResolvedRun`, `resolveProfile`, `JobSpec`, `ResolvedJob`, `resolveJobs`.
- Produces: `interface CheckConfig { name: string; cmd: string }` (exported from `src/config.ts`); `ProfileConfig.checks?: CheckConfig[]`; `ResolvedRun.checks: CheckConfig[]` (replaces nothing — `testCmd` field is REMOVED from `ResolvedRun`, desugared into `checks`); `JobSpec.checks?: CheckConfig[]` and `JobSpec.test_cmd?: string` (per-job override, same desugar); `resolveJobs` applies the override by replacing `run.checks`. Tasks 2/4/6 consume `ResolvedRun.checks`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/config.test.ts`:

```ts
const YAML_CHECKS = `
providers:
  local: { base_url: "http://127.0.0.1:1234/v1" }
tiers:
  cheap: { provider: local, model: "m" }
profiles:
  legacy:  { tools: [read_file, edit_file], tier: cheap, test_cmd: "bun test" }
  staged:
    tools: [read_file, edit_file, run_checks]
    tier: cheap
    checks:
      - { name: tests, cmd: "bun test" }
      - { name: style, cmd: "eslint src/" }
  both:    { tools: [read_file, edit_file], tier: cheap, test_cmd: "x", checks: [{ name: t, cmd: "y" }] }
  trigger: { tools: [read_file, run_checks], tier: cheap }
  nowt:    { tools: [read_file, run_checks], tier: cheap, checks: [{ name: t, cmd: "x" }] }
  dupes:
    tools: [read_file, edit_file]
    tier: cheap
    checks:
      - { name: tests, cmd: "a" }
      - { name: tests, cmd: "b" }
`;

describe("checks resolution", () => {
  it("desugars test_cmd into a single tests stage", () => {
    const r = resolveProfile(parseConfig(YAML_CHECKS), "legacy");
    expect(r.checks).toEqual([{ name: "tests", cmd: "bun test" }]);
  });

  it("resolves an ordered checks list as given", () => {
    const r = resolveProfile(parseConfig(YAML_CHECKS), "staged");
    expect(r.checks.map((c) => c.name)).toEqual(["tests", "style"]);
  });

  it("resolves an empty checks list for a profile with neither", () => {
    const r = resolveProfile(parseConfig(YAML_CHECKS.replace(/^  legacy.*$/m,
      '  legacy:  { tools: [read_file], tier: cheap }')), "legacy");
    expect(r.checks).toEqual([]);
  });

  it("rejects test_cmd and checks together — one spelling per profile", () => {
    expect(() => resolveProfile(parseConfig(YAML_CHECKS), "both"))
      .toThrow(/test_cmd.*checks|checks.*test_cmd/);
  });

  it("rejects run_checks in tools without any checks to run", () => {
    expect(() => resolveProfile(parseConfig(YAML_CHECKS), "trigger"))
      .toThrow(/run_checks.*no checks/);
  });

  it("rejects run_checks on a profile that runs without a worktree", () => {
    // Checks execute where the delegate edits. Without a worktree that
    // would be the caller's real tree — a caller-authored test command is
    // trusted to run, but only inside the disposable copy.
    expect(() => resolveProfile(parseConfig(YAML_CHECKS), "nowt"))
      .toThrow(/run_checks.*worktree/);
  });

  it("rejects duplicate stage names", () => {
    expect(() => resolveProfile(parseConfig(YAML_CHECKS), "dupes"))
      .toThrow(/duplicate check name 'tests'/);
  });

  it("rejects a stage missing name or cmd", () => {
    const bad = YAML_CHECKS.replace('{ name: tests, cmd: "bun test" }', '{ name: tests }');
    expect(() => resolveProfile(parseConfig(bad), "staged")).toThrow(/checks\[0\]/);
  });
});
```

Append to `tests/batch/jobs.test.ts` (the file's `CFG` const gains a write profile — extend the existing YAML string's `profiles:` block with `  fix: { tools: [read_file, edit_file], tier: cheap, test_cmd: "bun test" }`):

```ts
describe("per-job check overrides", () => {
  it("replaces the profile's checks with the job's test_cmd", () => {
    const specs = parseJobs(
      'jobs:\n  - { id: a, profile: fix, task: t, test_cmd: "bun test src/a.test.ts" }\n');
    const jobs = resolveJobs(CFG, specs, process.cwd());
    expect(jobs[0]!.run.checks).toEqual([{ name: "tests", cmd: "bun test src/a.test.ts" }]);
  });

  it("replaces the profile's checks with the job's staged list", () => {
    const specs = parseJobs(
      'jobs:\n  - { id: a, profile: fix, task: t, checks: [{ name: t1, cmd: "x" }, { name: t2, cmd: "y" }] }\n');
    const jobs = resolveJobs(CFG, specs, process.cwd());
    expect(jobs[0]!.run.checks.map((c) => c.name)).toEqual(["t1", "t2"]);
  });

  it("rejects a job carrying both spellings, naming the job", () => {
    const specs = parseJobs(
      'jobs:\n  - { id: bad, profile: fix, task: t, test_cmd: "x", checks: [{ name: n, cmd: "y" }] }\n');
    expect(() => resolveJobs(CFG, specs, process.cwd())).toThrow(/job 'bad'.*test_cmd.*checks/s);
  });

  it("leaves the profile's checks alone when the job overrides nothing", () => {
    const specs = parseJobs("jobs:\n  - { id: a, profile: fix, task: t }\n");
    const jobs = resolveJobs(CFG, specs, process.cwd());
    expect(jobs[0]!.run.checks).toEqual([{ name: "tests", cmd: "bun test" }]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test tests/config.test.ts tests/batch/jobs.test.ts`
Expected: FAIL — `checks` is not a `ResolvedRun` property; overrides unknown to `parseJobs`/`resolveJobs`.

- [ ] **Step 3: Extend `src/config.ts`**

1. New shape and validation helper (above `ProfileConfig`):

```ts
export interface CheckConfig {
  /** Short stage label; appears in the envelope's checks array. */
  name: string;
  /** Caller-authored shell command, run in the worktree. The model never writes this. */
  cmd: string;
}

/**
 * Validate a raw checks list from YAML. Shared by profile resolution and the
 * per-job override in batch — a bad stage must fail fast either way, naming
 * its position.
 */
export function validateChecks(raw: unknown, where: string): CheckConfig[] {
  if (!Array.isArray(raw)) throw new Error(`${where}: checks must be a list`);
  const seen = new Set<string>();
  return raw.map((c, i) => {
    if (c === null || typeof c !== "object" || Array.isArray(c)) {
      throw new Error(`${where}: checks[${i}] must be a mapping`);
    }
    const stage = c as Record<string, unknown>;
    if (typeof stage["name"] !== "string" || !stage["name"]) {
      throw new Error(`${where}: checks[${i}] missing 'name'`);
    }
    if (typeof stage["cmd"] !== "string" || !stage["cmd"]) {
      throw new Error(`${where}: checks[${i}] missing 'cmd'`);
    }
    if (seen.has(stage["name"])) {
      throw new Error(`${where}: duplicate check name '${stage["name"]}'`);
    }
    seen.add(stage["name"]);
    return { name: stage["name"], cmd: stage["cmd"] };
  });
}

/** test_cmd is sugar for a single tests stage; both spellings at once is ambiguous. */
export function desugarChecks(
  testCmd: string | undefined, checks: unknown, where: string,
): CheckConfig[] {
  if (testCmd !== undefined && checks !== undefined) {
    throw new Error(`${where}: give test_cmd or checks, not both`);
  }
  if (checks !== undefined) return validateChecks(checks, where);
  if (testCmd !== undefined) return [{ name: "tests", cmd: testCmd }];
  return [];
}
```

2. `ProfileConfig` gains `checks?: CheckConfig[]` (keep `test_cmd?: string`).

3. `ResolvedRun`: replace `testCmd?: string` with `checks: CheckConfig[]` (`testTimeoutMs` stays — it is now the per-stage timeout).

4. In `resolveProfile`, replace the `testCmd` spread in the returned object with:

```ts
    checks: resolvedChecks,
```

computed just before the return, after the worktree rules:

```ts
  const resolvedChecks = desugarChecks(
    profile.test_cmd, profile.checks, `profile '${profileName}'`);
  if (profile.tools.includes("run_checks") && resolvedChecks.length === 0) {
    throw new Error(
      `profile '${profileName}' lists run_checks but has no checks to run — ` +
        "add test_cmd or a checks list",
    );
  }
  if (profile.tools.includes("run_checks") && !worktree) {
    throw new Error(
      `profile '${profileName}' lists run_checks but runs without a worktree — ` +
        "checks execute where the delegate works; add a write tool or 'worktree: true'",
    );
  }
```

- [ ] **Step 4: Extend `src/batch/jobs.ts`**

`JobSpec` gains `test_cmd?: string` and `checks?: CheckConfig[]` (import the type). `parseJobs` passes them through when present:

```ts
      ...(typeof job["test_cmd"] === "string" ? { test_cmd: job["test_cmd"] } : {}),
      ...(job["checks"] !== undefined ? { checks: validateChecks(job["checks"], `jobs[${i}]`) } : {}),
```

`resolveJobs` applies the override after `resolveProfile`:

```ts
    if (spec.test_cmd !== undefined || spec.checks !== undefined) {
      let checks: CheckConfig[];
      try {
        checks = desugarChecks(spec.test_cmd, spec.checks, "job");
      } catch (e) {
        throw new Error(`job '${spec.id}': ${e instanceof Error ? e.message : String(e)}`);
      }
      run = { ...run, checks };
    }
```

(`run` becomes `let`; imports gain `desugarChecks`, `validateChecks`, `type CheckConfig`.)

- [ ] **Step 5: Fix the two existing `run.checks` consumers**

`src/run.ts` still reads `run.testCmd` — change the gate condition to `run.checks.length > 0` and pass `run.checks` (the call target updates fully in Task 4; for THIS task, keep the current single-command gate compiling by using `run.checks[0]!.cmd` where `run.testCmd` was, with a `// Task 4 replaces this with the staged runner` comment). `tests/cli-write.test.ts` and the batch write-gate test keep passing because their profiles use `test_cmd`, which desugars to the same single stage.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `bun test`
Expected: whole suite green — new tests pass, all existing `test_cmd` behavior unchanged through the desugar.

- [ ] **Step 7: Typecheck, then commit**

Run: `bun run typecheck` — silent, exit 0.

```bash
git add src/config.ts src/batch/jobs.ts src/run.ts tests/config.test.ts tests/batch/jobs.test.ts
git commit -m "feat: ordered checks in config — test_cmd desugars, jobs override per-job

A profile's gate becomes an ordered stage list; test_cmd stays as sugar
for a one-stage list so nothing existing moves. Jobs override checks
per-job — a batch of TDD jobs gates each job on its own failing test.
run_checks without any checks is a config error, caught at resolution."
```

---

### Task 2: Tail-biased truncation and the staged checks runner

Failures print at the END of test output; `markIfCut` keeps the head. In-loop coaching needs the tail. Then the gate generalizes: run stages in order, stop at the first failure.

**Files:**
- Modify: `src/text.ts`
- Modify: `src/testgate.ts`
- Test: `tests/text.test.ts` (create)
- Test: `tests/testgate.test.ts` (append)

**Interfaces:**
- Consumes: `CheckConfig` from `src/config.ts`; existing `runTestGate` internals.
- Produces: `markIfCutTail(text: string, limit: number): string` in `src/text.ts`; in `src/testgate.ts`: `interface StageResult { name: string; passed: boolean; timedOut: boolean; cmd: string; output: string }`, `interface ChecksResult { ran: boolean; passed: boolean; stages: StageResult[] }`, `runChecks(checks: CheckConfig[], cwd: string, timeoutMsPerStage: number, deadlineAt?: number): Promise<ChecksResult>`. `runTestGate` becomes the private per-stage primitive (renamed `runStage`, unexported); its tests are rewritten against `runChecks`. Tasks 3 and 4 consume `runChecks`.

- [ ] **Step 1: Write the failing tests**

Create `tests/text.test.ts`:

```ts
import { describe, it, expect } from "bun:test";
import { markIfCut, markIfCutTail } from "../src/text";

describe("markIfCutTail", () => {
  it("returns short text untouched", () => {
    expect(markIfCutTail("all of it", 100)).toBe("all of it");
  });

  it("keeps the tail and marks the front cut — failures print at the end", () => {
    const text = "HEAD-NOISE ".repeat(50) + "FAIL: expected 2, got 3";
    const cut = markIfCutTail(text, 60);
    expect(cut).toContain("FAIL: expected 2, got 3");
    expect(cut).not.toContain("HEAD-NOISE HEAD-NOISE HEAD-NOISE HEAD-NOISE");
    expect(cut).toMatch(/^\[\d+ chars cut from the front\]…/);
  });

  it("counts the cut honestly", () => {
    const text = "a".repeat(100) + "tail";
    const cut = markIfCutTail(text, 20);
    const counted = Number(cut.match(/^\[(\d+) chars cut/)![1]);
    expect(counted).toBe(text.length - 20);
  });
});

describe("markIfCut", () => {
  it("still keeps the head for diagnostics", () => {
    expect(markIfCut("abcdef", 3)).toBe("abc…");
  });
});
```

Append to `tests/testgate.test.ts` (imports gain `runChecks`; the file's existing `runTestGate` imports change to `runChecks` — the five existing single-command tests are REWRITTEN as single-stage `runChecks` calls, preserving every behavior they pin: pass, fail with both streams, cwd, timeout kill, output cap; e.g. `runTestGate("exit 0", cwd, 5000)` becomes `runChecks([{ name: "tests", cmd: "exit 0" }], cwd, 5000)` with assertions moving to `r.stages[0]`):

```ts
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test tests/text.test.ts tests/testgate.test.ts`
Expected: FAIL — `markIfCutTail` and `runChecks` are not exported.

- [ ] **Step 3: Add `markIfCutTail` to `src/text.ts`**

```ts
/**
 * Tail-keeping counterpart to markIfCut: check runners print failures at the
 * END of their output, so in-loop coaching must keep the tail and mark what
 * was dropped from the front — never silently.
 */
export function markIfCutTail(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `[${text.length - limit} chars cut from the front]…${text.slice(-limit)}`;
}
```

- [ ] **Step 4: Rework `src/testgate.ts`**

Rename `runTestGate` to a private `runStage` (same body — spawn, SIGKILL-at-deadline, cancellable drains, `markIfCut` cap; drop the `export`, keep `MAX_TEST_OUTPUT_CHARS` exported). Add above it:

```ts
import type { CheckConfig } from "./config";

export interface StageResult {
  name: string;
  passed: boolean;
  timedOut: boolean;
  cmd: string;
  /** Combined stdout+stderr, mark-if-cut at MAX_TEST_OUTPUT_CHARS. */
  output: string;
}

export interface ChecksResult {
  /** False only for an empty pipeline — nothing ran, nothing to fail. */
  ran: boolean;
  passed: boolean;
  /** Stages actually executed, in order. Stops after the first failure. */
  stages: StageResult[];
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
```

(`runStage`'s return keeps its current `{ran, passed, timedOut, cmd, output}` shape internally; only `runChecks` is public now.)

- [ ] **Step 5: Fix the one production consumer**

`src/run.ts`'s gate call (temporarily on `run.checks[0]!.cmd` from Task 1) switches to `runChecks(run.checks, worktreeDir, run.testTimeoutMs, req.deadlineAt)` — full envelope wiring is Task 4; for this task map the result onto the existing `EnvelopeTest` as `{ ran: r.ran, passed: r.passed, cmd: r.stages[r.stages.length - 1]?.cmd ?? "" }` and join stage outputs for `test_output`, with a `// Task 4 carries per-stage detail into the envelope` comment.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `bun test` — whole suite green (cli-write's gate tests exercise the single-stage path through the new runner).

- [ ] **Step 7: Typecheck, then commit**

```bash
git add src/text.ts src/testgate.ts src/run.ts tests/text.test.ts tests/testgate.test.ts
git commit -m "feat: staged checks runner with tail-biased truncation

Stages run in order and stop at the first failure — the ordering rule
('no style coaching until tests pass') is pipeline shape, not logic, and
the failing stage's output is the coaching. markIfCutTail keeps the end
of runner output where the failures live, marking the front cut honestly."
```

---

### Task 3: The `run_checks` tool

A per-run closure over the config's checks: the model pulls the trigger, the caller loaded it. Zero arguments — no command text ever crosses from the model — and a hard invocation budget so a churning delegate can't spend the deadline re-running a red suite.

**Files:**
- Create: `src/tools/checks.ts`
- Test: `tests/tools/checks.test.ts`

**Interfaces:**
- Consumes: `CheckConfig` from `src/config.ts`; `runChecks` from `src/testgate.ts`; `markIfCutTail` from `src/text.ts`; `Tool`/`ToolContext`/`ToolResult` from `src/tools/types.ts`.
- Produces: `RUN_CHECKS_NAME = "run_checks"`, `DEFAULT_MAX_CHECK_RUNS = 3`, `makeRunChecks(checks: CheckConfig[], timeoutMsPerStage: number, deadlineAt?: number, maxRuns?: number): Tool`. Task 4's `executeRun` constructs one per run; the static registry never holds it.

- [ ] **Step 1: Write the failing tests**

Create `tests/tools/checks.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test tests/tools/checks.test.ts`
Expected: FAIL — cannot resolve `../../src/tools/checks`.

- [ ] **Step 3: Create `src/tools/checks.ts`**

```ts
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
        return { content: `${lines.join("\n")}\nAll checks pass.`, truncated: false };
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test tests/tools/checks.test.ts`
Expected: PASS, 7 tests. Then `bun test` — whole suite green.

- [ ] **Step 5: Typecheck, then commit**

```bash
git add src/tools/checks.ts tests/tools/checks.test.ts
git commit -m "feat: run_checks — the model pulls triggers the caller loaded

A per-run closure over the config's ordered checks: zero arguments, so no
command text ever crosses the model boundary; a three-call budget, so a
churning delegate cannot spend its deadline re-running a red suite; the
failing stage's tail (failures print at the end) as the coaching. The
loop's existing worst-turn gate already counts check time — one test pins
that the deadline machinery sees slow checks exactly like slow backends."
```

---

### Task 4: Envelope per-stage detail and `executeRun` wiring

The envelope keeps `test` as the overall verdict — every batch predicate (`rollup.ts` clean, `escalate.ts` needsEscalation) stays untouched — and gains a `checks` array for per-stage detail. `executeRun` swaps the interim single-command mapping for the staged runner and injects the `run_checks` tool.

**Files:**
- Modify: `src/envelope.ts`
- Modify: `src/transcript.ts`
- Modify: `src/run.ts`
- Test: `tests/envelope.test.ts` (append)

**Interfaces:**
- Consumes: `ChecksResult`/`StageResult` from `src/testgate.ts`; `makeRunChecks`/`RUN_CHECKS_NAME` from `src/tools/checks.ts`.
- Produces: `interface CheckVerdict { name: string; passed: boolean; timedOut: boolean }`; `Envelope.checks?: CheckVerdict[]`; `WriteOutcome.checks?: CheckVerdict[]` (alongside the existing `test?: EnvelopeTest`); `TranscriptData.test_output` now carries per-stage sections. Task 6 asserts the wire shape end to end; Phase B's scorer reads `envelope.checks`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/envelope.test.ts` (inside the existing `describe("write outcome fields")`, reusing its `writes` fixture):

```ts
  it("carries per-stage check verdicts alongside the overall test verdict", () => {
    const e = buildEnvelope(result, {
      wallSecs: 1, transcript: "/t", contextLimit: null,
      writes: {
        ...writes,
        test: { ran: true, passed: false, cmd: "eslint src/" },
        checks: [
          { name: "tests", passed: true, timedOut: false },
          { name: "style", passed: false, timedOut: false },
        ],
      },
    });
    expect(e.test).toEqual({ ran: true, passed: false, cmd: "eslint src/" });
    expect(e.checks).toEqual([
      { name: "tests", passed: true, timedOut: false },
      { name: "style", passed: false, timedOut: false },
    ]);
  });

  it("omits checks when the write outcome has none", () => {
    const e = buildEnvelope(result, {
      wallSecs: 1, transcript: "/t", contextLimit: null, writes,
    });
    expect(e.checks).toBeUndefined();
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test tests/envelope.test.ts`
Expected: FAIL — `checks` is not a `WriteOutcome`/`Envelope` property.

- [ ] **Step 3: Extend `src/envelope.ts`**

Below `EnvelopeTest`:

```ts
export interface CheckVerdict {
  name: string;
  passed: boolean;
  timedOut: boolean;
}
```

`WriteOutcome` gains `checks?: CheckVerdict[];` (after `test`). `Envelope` gains `checks?: CheckVerdict[];` (after `test`). In `buildEnvelope`'s writes block, after the `test` assignment:

```ts
    if (o.writes.checks) envelope.checks = o.writes.checks;
```

(Bounded by construction: stage count is caller-authored config, the same argument as `files_changed`'s entry cap.)

- [ ] **Step 4: Rewire `src/run.ts`**

1. Imports gain `makeRunChecks`, `RUN_CHECKS_NAME` from `./tools/checks` and (already present from Task 2) `runChecks` from `./testgate`.

2. Tool resolution — replace `const tools = resolveTools(run.tools);` with:

```ts
  // run_checks is a per-run closure, not a registry entry: it must capture
  // THIS run's checks and deadline. The static resolver never sees the name.
  const tools = resolveTools(run.tools.filter((n) => n !== RUN_CHECKS_NAME));
  if (run.tools.includes(RUN_CHECKS_NAME)) {
    tools.push(makeRunChecks(run.checks, run.testTimeoutMs, req.deadlineAt));
  }
```

3. Post-loop gate — replace the Task-2 interim block inside the `changes.files.length > 0` branch with:

```ts
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
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun test`
Expected: whole suite green — `tests/cli-write.test.ts` still passes (single-stage `test_cmd` profiles produce the same `test` object as before; `checks` rides along as a one-entry array, which no existing assertion forbids — if an exact-equality assertion on the envelope fails, the fixture gains the expected one-entry `checks` array; report which).

- [ ] **Step 6: Typecheck, then commit**

```bash
git add src/envelope.ts src/transcript.ts src/run.ts tests/envelope.test.ts tests/cli-write.test.ts
git commit -m "feat: per-stage check verdicts in the envelope; run_checks injected per run

test stays the overall verdict so every batch predicate reads exactly what
it read before; checks[] carries the per-stage detail an orchestrator needs
to see which coaching stage failed. The run_checks tool is constructed per
run, closed over this run's checks and deadline — the static registry never
holds a tool whose behavior depends on config."
```

---

### Task 5: Syntax feedback riding on every write

The dominant small-model write failure is a malformed edit. `Bun.Transpiler` parses in-process in milliseconds — the note rides the edit's own tool result: same turn, zero extra cost, no subprocess.

**Files:**
- Create: `src/tools/syntax.ts`
- Modify: `src/tools/edit.ts`
- Modify: `src/tools/write.ts`
- Test: `tests/tools/edit.test.ts` (append)
- Test: `tests/tools/write.test.ts` (append)

**Interfaces:**
- Consumes: `Bun.Transpiler` (built-in).
- Produces: `syntaxNote(path: string, content: string): string` — empty string for clean or non-JS/TS files, a marked one-line note otherwise. Both write tools append it to their result content.

- [ ] **Step 1: Write the failing tests**

Append to `tests/tools/edit.test.ts`:

```ts
  it("appends a syntax note when the edit breaks the file's parse", async () => {
    await read("src/a.ts");
    const r = await editFile.run(
      { path: "src/a.ts", old_string: "const b = 2;", new_string: "const b = ;" },
      { root, session },
    );
    expect(r.content).toContain("[SYNTAX:");
    expect(r.content).toContain("fix before finishing");
  });

  it("appends no note for a clean edit", async () => {
    await read("src/a.ts");
    const r = await editFile.run(
      { path: "src/a.ts", old_string: "const b = 2;", new_string: "const b = 20;" },
      { root, session },
    );
    expect(r.content).not.toContain("[SYNTAX:");
  });
```

Append to `tests/tools/write.test.ts`:

```ts
  it("appends a syntax note when written TS does not parse", async () => {
    const r = await writeFile.run(
      { path: "src/broken.ts", content: "export const x: number = ;\n" },
      { root, session },
    );
    expect(r.content).toContain("[SYNTAX:");
  });

  it("skips syntax checking for non-JS/TS files", async () => {
    const r = await writeFile.run(
      { path: "notes.md", content: "not : valid ( ts — and that is fine\n" },
      { root, session },
    );
    expect(r.content).not.toContain("[SYNTAX:");
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test tests/tools/edit.test.ts tests/tools/write.test.ts`
Expected: FAIL — no syntax notes appear.

- [ ] **Step 3: Create `src/tools/syntax.ts`**

```ts
const LOADERS: Record<string, "ts" | "tsx" | "js" | "jsx"> = {
  ".ts": "ts", ".tsx": "tsx", ".js": "js", ".jsx": "jsx",
};

/**
 * In-process parse check for freshly written content — milliseconds, no
 * subprocess. A malformed edit is the dominant small-model write failure,
 * and this note reaches the model in the same turn the damage happened,
 * instead of surfacing as a red gate after the loop ends. Returns "" for
 * clean or non-JS/TS content; never throws (the write already succeeded —
 * the note coaches, it does not veto).
 */
export function syntaxNote(path: string, content: string): string {
  const dot = path.lastIndexOf(".");
  const loader = dot === -1 ? undefined : LOADERS[path.slice(dot)];
  if (!loader) return "";
  try {
    new Bun.Transpiler({ loader }).transformSync(content);
    return "";
  } catch (e) {
    const first = String(
      e instanceof AggregateError ? (e.errors[0] ?? e) : e,
    ).split("\n")[0];
    return `\n[SYNTAX: ${first} — fix before finishing.]`;
  }
}
```

- [ ] **Step 4: Wire both write tools**

`src/tools/edit.ts`: import `syntaxNote`; the return's `content` becomes

```ts
        `Edited ${rel} (${count} replacement${count === 1 ? "" : "s"}).\n` +
        snippet(updated, changeIndex) +
        syntaxNote(path, updated),
```

`src/tools/write.ts`: import `syntaxNote`; the return's `content` becomes

```ts
      content: `Wrote ${rel} (${lines} line${lines === 1 ? "" : "s"}).${syntaxNote(path, content)}`,
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun test` — whole suite green (existing edit/write fixtures are valid TS, so no note appears in their assertions).

- [ ] **Step 6: Typecheck, then commit**

```bash
git add src/tools/syntax.ts src/tools/edit.ts src/tools/write.ts tests/tools/edit.test.ts tests/tools/write.test.ts
git commit -m "feat: syntax notes ride on every write — same turn, no subprocess

Bun.Transpiler parses the fresh content in-process; a malformed edit gets
its coaching in the tool result that made it, instead of surfacing as a
red gate after the loop ends. The note never vetoes: the write stood, the
model fixes it with the budget it still has."
```

---

### Task 6: End-to-end — staged gates, in-loop checks, per-job overrides

The Phase A integration seams, each through the real CLI subprocess: stage ordering visible in the envelope, `run_checks` driven mid-loop by a scripted model, and a batch job gating on its own overridden command. This is the cross-feature coverage whose absence let the last branch's Critical hide.

**Files:**
- Test: `tests/cli-checks.test.ts` (create)

**Interfaces:**
- Consumes: everything Tasks 1–5 shipped, through `bun src/cli.ts` subprocesses.
- Produces: nothing — tests only.

- [ ] **Step 1: Write the failing tests**

Create `tests/cli-checks.test.ts` (fixture helpers `sh`/`initRepo`/`serveScript`/`call`/`answer` copied from `tests/cli-write.test.ts` — suite convention keeps each e2e file self-contained):

```ts
import { describe, it, expect, afterEach } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(import.meta.dir, "..", "src", "cli.ts");

async function sh(cwd: string, ...cmd: string[]): Promise<void> {
  const proc = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  if ((await proc.exited) !== 0) {
    throw new Error(`${cmd.join(" ")} failed: ${await new Response(proc.stderr).text()}`);
  }
}

async function initRepo(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "subagents-clichecks-"));
  await sh(dir, "git", "init", "-q");
  await sh(dir, "git", "config", "user.email", "test@example.com");
  await sh(dir, "git", "config", "user.name", "test");
  await sh(dir, "git", "config", "commit.gpgsign", "false");
  writeFileSync(join(dir, "a.ts"), "const a = 1;\n");
  await sh(dir, "git", "add", "-A");
  await sh(dir, "git", "commit", "-qm", "init");
  return dir;
}

function serveScript(script: object[]): { url: string; stop(): void; seen: any[] } {
  const seen: any[] = [];
  let i = 0;
  const server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      seen.push(await req.json());
      const next = script[Math.min(i, script.length - 1)];
      i++;
      return Response.json(next);
    },
  });
  return { url: `http://127.0.0.1:${server.port}/v1`, stop: () => server.stop(true), seen };
}

const call = (id: string, name: string, args: object) => ({
  choices: [{
    message: {
      role: "assistant", content: null,
      tool_calls: [{ id, function: { name, arguments: JSON.stringify(args) } }],
    },
    finish_reason: "tool_calls",
  }],
  usage: { prompt_tokens: 100, completion_tokens: 10 },
});

const answer = (text: string) => ({
  choices: [{ message: { role: "assistant", content: text }, finish_reason: "stop" }],
  usage: { prompt_tokens: 100, completion_tokens: 10 },
});

/** Read a.ts, change 1 → 2, answer. */
const EDIT_SCRIPT = [
  call("c1", "read_file", { path: "a.ts" }),
  call("c2", "edit_file", { path: "a.ts", old_string: "const a = 1;", new_string: "const a = 2;" }),
  answer("changed a to 2"),
];

function writeConfig(repo: string, url: string, profileYaml: string): string {
  const path = join(repo, "subagents.yaml");
  writeFileSync(path, `
providers:
  test: { base_url: "${url}" }
tiers:
  cheap: { provider: test, model: "fake-model" }
profiles:
${profileYaml}
`);
  return path;
}

async function runCli(args: string[]): Promise<{ code: number; out: string; err: string }> {
  const proc = Bun.spawn(["bun", CLI, ...args], { stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code: await proc.exited, out, err };
}

const cleanups: string[] = [];
afterEach(() => {
  for (const dir of cleanups.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("staged checks through the CLI", () => {
  it("reports the failing stage and stops before later ones", async () => {
    const repo = await initRepo();
    cleanups.push(repo);
    const srv = serveScript(EDIT_SCRIPT);
    try {
      // tests pass after the edit; style demands a line the file lacks.
      const cfg = writeConfig(repo, srv.url, `  fix:
    tools: [read_file, edit_file]
    tier: cheap
    checks:
      - { name: tests, cmd: "grep -q 'const a = 2;' a.ts" }
      - { name: style, cmd: "grep -q COPYRIGHT a.ts" }`);
      const { code, out } = await runCli([
        "run", "--profile", "fix", "--task", "bump a", "--root", repo, "--config", cfg]);
      expect(code).toBe(2);
      const env = JSON.parse(out);
      cleanups.push(env.worktree);
      expect(env.status).toBe("ok");
      expect(env.checks).toEqual([
        { name: "tests", passed: true, timedOut: false },
        { name: "style", passed: false, timedOut: false },
      ]);
      expect(env.test.passed).toBe(false);
      expect(env.test.cmd).toBe("grep -q COPYRIGHT a.ts");
      expect(existsSync(join(env.worktree, "a.ts"))).toBe(true);
      const transcript = await Bun.file(env.transcript).json();
      expect(transcript.test_output).toContain("=== tests: pass ===");
      expect(transcript.test_output).toContain("=== style: fail ===");
    } finally {
      srv.stop();
    }
  });

  it("never runs style when tests fail", async () => {
    const repo = await initRepo();
    cleanups.push(repo);
    const srv = serveScript(EDIT_SCRIPT);
    try {
      const cfg = writeConfig(repo, srv.url, `  fix:
    tools: [read_file, edit_file]
    tier: cheap
    checks:
      - { name: tests, cmd: "grep -q 'const a = 999;' a.ts" }
      - { name: style, cmd: "exit 0" }`);
      const { code, out } = await runCli([
        "run", "--profile", "fix", "--task", "bump a", "--root", repo, "--config", cfg]);
      expect(code).toBe(2);
      const env = JSON.parse(out);
      cleanups.push(env.worktree);
      expect(env.checks).toEqual([{ name: "tests", passed: false, timedOut: false }]);
    } finally {
      srv.stop();
    }
  });

  it("lets the delegate drive run_checks mid-loop and see the verdict", async () => {
    const repo = await initRepo();
    cleanups.push(repo);
    const srv = serveScript([
      call("c1", "read_file", { path: "a.ts" }),
      call("c2", "run_checks", {}),           // red: the edit hasn't happened
      call("c3", "edit_file", { path: "a.ts", old_string: "const a = 1;", new_string: "const a = 2;" }),
      call("c4", "run_checks", {}),           // green
      answer("fixed and verified"),
    ]);
    try {
      const cfg = writeConfig(repo, srv.url, `  fix:
    tools: [read_file, edit_file, run_checks]
    tier: cheap
    test_cmd: "grep -q 'const a = 2;' a.ts"`);
      const { code, out } = await runCli([
        "run", "--profile", "fix", "--task", "bump a", "--root", repo, "--config", cfg]);
      expect(code).toBe(0);
      const env = JSON.parse(out);
      cleanups.push(env.worktree);
      expect(env.test.passed).toBe(true);
      const transcript = await Bun.file(env.transcript).json();
      const toolMsgs = transcript.messages.filter((m: any) => m.role === "tool");
      const checkResults = toolMsgs.filter((m: any) => m.content.includes("tests:"));
      expect(checkResults).toHaveLength(2);
      expect(checkResults[0]!.content).toContain("tests: FAIL");
      expect(checkResults[1]!.content).toContain("All checks pass.");
    } finally {
      srv.stop();
    }
  });
});

describe("per-job check overrides through batch", () => {
  it("gates each job on its own command, not the profile's", async () => {
    const repo = await initRepo();
    cleanups.push(repo);
    const srv = serveScript(EDIT_SCRIPT);
    try {
      const cfg = writeConfig(repo, srv.url, `  fix:
    tools: [read_file, edit_file]
    tier: cheap
    test_cmd: "exit 1"`);
      const jobs = join(repo, "jobs.yaml");
      writeFileSync(jobs, `
jobs:
  - { id: own-gate, profile: fix, task: "bump a", test_cmd: "grep -q 'const a = 2;' a.ts" }
`);
      const { code, out } = await runCli([
        "batch", "--jobs", jobs, "--root", repo, "--config", cfg,
        "--transcript-dir", join(repo, "transcripts")]);
      expect(code).toBe(0); // the override passes even though the profile's cmd never could
      const rollup = JSON.parse(out);
      expect(rollup.status).toBe("ok");
      const env = rollup.jobs[0]!.final.envelope;
      cleanups.push(env.worktree);
      expect(env.test).toEqual({
        ran: true, passed: true, cmd: "grep -q 'const a = 2;' a.ts",
      });
    } finally {
      srv.stop();
    }
  });
});
```

- [ ] **Step 2: Run the tests to verify current behavior**

Run: `bun test tests/cli-checks.test.ts`
Expected: PASS if Tasks 1–5 landed correctly — this task is the integration net, so a failure here is a real wiring bug in an earlier task: fix it there (with its own covering unit test) before proceeding, and report what was found.

- [ ] **Step 3: Run the whole suite and typecheck**

Run: `bun test && bun run typecheck`
Expected: green and silent.

- [ ] **Step 4: Commit**

```bash
git add tests/cli-checks.test.ts
git commit -m "test: Phase A seams end to end — staging, in-loop checks, per-job gates

The last branch's Critical lived exactly where task-scoped tests could not
see: two features composed. These cross the seams deliberately: stage
order visible in the envelope, a scripted delegate watching run_checks go
red then green mid-loop, and a batch job gating on its own overridden
command while the profile's would always fail."
```

---

### Task 7: SKILL.md TDD delegation workflow — baseline first — and docs sweep A

Per writing-skills: baseline scenarios BEFORE authoring. Author only what the baseline fails; a passing baseline shrinks the addition to reference facts. Then move every other Phase A doc surface.

**Files:**
- Modify: `skills/subagents/SKILL.md`
- Modify: `README.md`, `docs/design.md`, `subagents.example.yaml`, `CLAUDE.md`

**Interfaces:** prose only; claims verified against `src/` per the checks below.

- [ ] **Step 1: RED — run the baseline scenarios**

Two scenarios, two reps each, cheap model, single-shot subagents given the CURRENT SKILL.md text (paste the relevant sections verbatim) and no new guidance:

Scenario 1 — *spec-as-test dispatch*: "You need a delegate to change `parseRetryAfter()` to also accept HTTP-date values. You have bash and full repo access yourself; the delegate has read/edit tools, a worktree, and a per-job `test_cmd`. Write the exact dispatch you'd make: the task text and the test_cmd." Failure = a prose-only task with a generic suite as `test_cmd` (no failing spec test authored first).

Scenario 2 — *tamper acceptance*: "A write job returns exit 0; `files_changed: ["src/retry.ts", "tests/retry.test.ts"]`, gate passed. Your dispatch had written tests/retry.test.ts as the spec. Do you apply the diff?" Failure = accepting without flagging that the delegate edited the spec test.

Document verbatim behavior in the implementation report. **Decision rule:** author a workflow section only for the scenario(s) that fail; if both pass, add only a two-sentence reference note (per-job `test_cmd` + `run_checks` exist; the RED-test recipe in one line) and record the passing baseline in the report.

- [ ] **Step 2: GREEN — author against observed failures, re-run the failing scenarios**

If Scenario 1 failed, add after the **Tiering** section:

```markdown
## TDD delegation: the test is the task

For behavior changes, don't describe the change — hand over a failing test:

1. **You** write the spec test and run it RED yourself; commit it (the
   delegate sees your last commit — the RED state must be in it).
2. Dispatch with the test as the gate:
   `--task "tests/retry.test.ts::accepts HTTP-dates fails; make it pass" `
   plus a per-job `test_cmd` (or `checks`) running exactly that test.
3. The delegate (give it `run_checks`) watches itself go green in-loop;
   the harness gate re-verifies after the loop.
4. Accept mechanically: exit 0, AND `files_changed` does **not** include
   your spec test (a delegate that edits the spec passed nothing), AND you
   read the diff.

Specifying behavior is judgment — keep it. Making a red test green is
mechanical — delegate it, cheap tier first.
```

If Scenario 2 failed, add the tamper rule to **Trust rules**:

```markdown
- **A diff that touches your spec test proved nothing.** Check
  `files_changed` before reading anything else; if the test you authored is
  in it, reject the run.
```

Re-run the failed scenario(s) with the amended text — compliance required before proceeding; iterate wording once if needed and report both rounds.

- [ ] **Step 3: Reference updates (no baseline needed — capability listing)**

SKILL.md: "What ships today" tool list gains `run_checks` (seventh tool, "run the profile's configured checks in order — no arguments"); the **Write profiles** section's gate bullet mentions ordered `checks` and that budget must cover every stage; "Reading the envelope" example gains `"checks": [{"name": "tests", "passed": true, "timedOut": false}]` with one line: per-stage detail, `test` stays the overall verdict.

- [ ] **Step 4: Sweep the other surfaces**

- `README.md`: "What ships today" — the test-gate bullet becomes ordered checks ("tests, then style — stop at first failure; the failing stage's output is the delegate's coaching"), and mentions `run_checks` + the syntax ridealong.
- `docs/design.md`: Tool contract table gains a `run_checks` row (zero-arg, caller-authored commands, budget 3); the Safety section notes the model never authors command text; status paragraph updated.
- `subagents.example.yaml`: the `fix` profile becomes a staged example (`checks:` with tests + a style stand-in, `run_checks` in tools) with a comment on ordering.
- `CLAUDE.md`: commands section notes `checks`/`run_checks` exist and that wire-shape or gate changes still get live verification.

- [ ] **Step 5: Verify and commit**

Checks: every tool named in docs exists in the registry or is `run_checks` (seven total); SKILL claims match `src/config.ts` validation behavior; `bun test` still green (docs only).

```bash
git add skills/subagents/SKILL.md README.md docs/design.md subagents.example.yaml CLAUDE.md
git commit -m "docs: checks pipeline on every surface; TDD delegation per its baseline

The skill's TDD section is exactly as large as its baseline failures —
scenarios run first, guidance authored only for what agents got wrong
without it, re-verified after. Reference surfaces gain run_checks, staged
checks, and the syntax ridealong as shipped facts."
```

---

# Phase B — benchmark suite and debug logging (Tasks 8–13)

### Task 8: Per-turn event logging

One structured event per turn, from one emission site, serving bench runs and real workloads with the same format. `onTurn` becomes a derivation of the richer event — no double-fire, no second code path.

**Files:**
- Modify: `src/loop.ts`
- Modify: `src/run.ts`
- Modify: `src/cli.ts`
- Test: `tests/loop.test.ts` (append)
- Test: `tests/cli.test.ts` (append)

**Interfaces:**
- Consumes: the loop's existing turn structure and `safeOnTurn` seam.
- Produces: `interface ToolCallEvent { name: string; argsChars: number; resultChars: number; truncated: boolean }`, `interface TurnEvent { turn: number; latencyMs: number; backendMs: number; toolCalls: ToolCallEvent[]; promptTokens?: number; completionTokens?: number; finishReason?: string }`, `LoopOptions.onEvent?: (e: TurnEvent) => void`; `RunRequest.logPath?: string` (executeRun appends one JSON line per event, `ts` added); `run --log <path>`; batch writes `<id><suffix>.log.jsonl` beside each transcript. Phase B's runner and any real workload read the same lines.

- [ ] **Step 1: Write the failing tests**

Append to `tests/loop.test.ts`:

```ts
describe("runLoop events", () => {
  it("emits one event per turn with tool and token detail", async () => {
    const events: import("../src/loop").TurnEvent[] = [];
    const backend = new ScriptedBackend([
      assistant(null, [["c1", "t", '{"a":1}']]),
      assistant("done"),
    ]);
    await runLoop({
      ...base, backend,
      tools: [fakeTool("t", { content: "0123456789", truncated: true })],
      onEvent: (e) => events.push(e),
    });
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      turn: 1,
      toolCalls: [{ name: "t", argsChars: 7, resultChars: 10, truncated: true }],
      promptTokens: 100,
      completionTokens: 10,
    });
    expect(events[0]!.latencyMs).toBeGreaterThanOrEqual(events[0]!.backendMs);
    expect(events[1]!.toolCalls).toEqual([]);
    expect(events[1]!.finishReason).toBe("stop");
  });

  it("keeps onTurn working, derived from the same emission", async () => {
    const turns: number[] = [];
    const events: number[] = [];
    const backend = new ScriptedBackend([assistant("done")]);
    await runLoop({
      ...base, backend, tools: [],
      onTurn: (t) => turns.push(t),
      onEvent: (e) => events.push(e.turn),
    });
    expect(turns).toEqual([1]);
    expect(events).toEqual([1]);
  });

  it("survives a throwing onEvent — observers never cost the run", async () => {
    const backend = new ScriptedBackend([assistant("done")]);
    const r = await runLoop({
      ...base, backend, tools: [],
      onEvent: () => { throw new Error("observer bug"); },
    });
    expect(r.status).toBe("ok");
  });
});
```

Append to `tests/cli.test.ts` (inside the existing describe, reusing its fixture server):

```ts
  it("writes parseable per-turn JSONL to --log, tokens summing to the envelope", async () => {
    const logPath = join(root, "run.log.jsonl");
    const proc = Bun.spawn(
      ["bun", CLI, "run", "--profile", "digest", "--task", "where is the answer?",
       "--root", root, "--config", join(root, "subagents.yaml"), "--log", logPath],
      { stdout: "pipe", stderr: "pipe" },
    );
    const out = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(0);
    const env = JSON.parse(out);
    const events = (await Bun.file(logPath).text()).trim().split("\n").map((l) => JSON.parse(l));
    expect(events).toHaveLength(env.turns);
    const logged = events.reduce(
      (s, e) => s + (e.promptTokens ?? 0) + (e.completionTokens ?? 0), 0);
    expect(logged).toBe(env.local_tokens);
    expect(typeof events[0].ts).toBe("number");
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test tests/loop.test.ts tests/cli.test.ts`
Expected: FAIL — `onEvent`/`TurnEvent` unknown; `--log` is an unknown option.

- [ ] **Step 3: Rework the loop's emission**

In `src/loop.ts`:

1. Export the event shapes and extend options:

```ts
export interface ToolCallEvent {
  name: string;
  argsChars: number;
  resultChars: number;
  truncated: boolean;
}

export interface TurnEvent {
  turn: number;
  /** Full turn: backend round trip plus every tool dispatched. */
  latencyMs: number;
  backendMs: number;
  toolCalls: ToolCallEvent[];
  promptTokens?: number;
  completionTokens?: number;
  finishReason?: string;
}
```

`LoopOptions` gains `onEvent?: (e: TurnEvent) => void;`.

2. Replace `safeOnTurn` with one guarded emitter deriving both callbacks:

```ts
/** Observers are advisory: a throwing callback must never cost the caller its result. */
function emitTurn(o: LoopOptions, e: TurnEvent): void {
  try { o.onEvent?.(e); } catch { /* swallowed deliberately */ }
  try { o.onTurn?.(e.turn, e.latencyMs / 1000, e.toolCalls.map((t) => t.name)); } catch { /* ditto */ }
}
```

3. Change `dispatch` to return `{ content: string; truncated: boolean }` (dropping the `onTruncated` callback — the loop increments `truncations` itself), and in the tool-calls loop collect events:

```ts
    const toolEvents: ToolCallEvent[] = [];
    for (const call of calls) {
      const r = await dispatch(call.function.name, call.function.arguments, byName, o, session);
      if (r.truncated) truncations++;
      toolEvents.push({
        name: call.function.name,
        argsChars: call.function.arguments.length,
        resultChars: r.content.length,
        truncated: r.truncated,
      });
      messages.push({ role: "tool", tool_call_id: call.id, content: r.content });
    }
```

4. At each of the three per-turn emission sites (budget return, completion return, end of a tool turn), build the event once — `backendMs` captured right after the `chat` await (`const backendMs = Date.now() - started;`), `latencyMs: Date.now() - started` at emission, `promptTokens`/`completionTokens` from this turn's `res.usage`, `finishReason: choice.finish_reason`, `toolCalls` empty on the two terminal sites — and call `emitTurn(o, event)` where `safeOnTurn` fired before. Inside `dispatch`, error strings return `{ content: ..., truncated: false }`.

- [ ] **Step 4: Wire the writers**

`src/run.ts`: `RunRequest` gains `logPath?: string;`. In `executeRun`, compose the loop's `onEvent`:

```ts
import { appendFileSync } from "node:fs";
```

```ts
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
```

`src/cli.ts`: `run` gains `--log <path>` (STRING_OPTS + option + USAGE line "Per-turn JSONL events — turn, latency, tools, tokens"); `runMain` passes `logPath`. `batchMain`'s `runJob` passes `logPath: join(transcriptDir, \`${job.id}${suffix}.log.jsonl\`)` unconditionally — logs live beside transcripts, cheap and always useful.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun test` — whole suite green (the `onTurn` derivation keeps `--verbose` output identical; existing loop tests that used the `onTruncated` callback shape via `dispatch` are internal-only — no test touches `dispatch` directly).

- [ ] **Step 6: Typecheck, then commit**

```bash
git add src/loop.ts src/run.ts src/cli.ts tests/loop.test.ts tests/cli.test.ts
git commit -m "feat: per-turn event stream — one format for bench and real workloads

One emission site per turn carrying latency split, per-tool arg/result
sizes, truncation flags, and token counts; onTurn becomes a derivation so
--verbose costs nothing new. run --log writes JSONL; batch logs beside
every transcript. Transcripts say what was said — logs say what it cost."
```

---

### Task 9: Fixture format, loader, and the committed read fixtures

A fixture is a directory: `fixture.yaml` (task, tools, optional checks, oracle) plus `files/` copied into a throwaway repo. The two committed fixtures port the 2026-08-06 lan-host bench so the suite's first baseline is numbers we already trust.

**Files:**
- Create: `src/bench/fixture.ts`
- Create: `bench/fixtures/routes-recall/fixture.yaml`, `bench/fixtures/routes-recall/files/src/routes.ts`, `bench/fixtures/routes-recall/files/src/zod-stub.ts`
- Create: `bench/fixtures/greet-typo/fixture.yaml`, `bench/fixtures/greet-typo/files/src/greet.ts`
- Test: `tests/bench/fixture.test.ts`

**Interfaces:**
- Consumes: `validateChecks`, `CheckConfig` from `src/config.ts`; `ALL_TOOLS` from `src/tools/registry.ts`; `RUN_CHECKS_NAME` from `src/tools/checks.ts`.
- Produces: `interface FixtureOracle { status?: string; checks_pass?: boolean; files_changed?: string[]; summary_must_match?: string[]; summary_must_not_match?: string[] }`, `interface Fixture { name: string; dir: string; task: string; tools: string[]; checks: CheckConfig[]; oracle: FixtureOracle }`, `loadFixture(dir: string): Promise<Fixture>`. Tasks 10–12 consume all of it.

- [ ] **Step 1: Write the failing tests**

Create `tests/bench/fixture.test.ts`:

```ts
import { describe, it, expect } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadFixture } from "../../src/bench/fixture";

function makeFixture(yaml: string, withFiles = true): string {
  const dir = mkdtempSync(join(tmpdir(), "subagents-fx-"));
  writeFileSync(join(dir, "fixture.yaml"), yaml);
  if (withFiles) {
    mkdirSync(join(dir, "files", "src"), { recursive: true });
    writeFileSync(join(dir, "files", "src", "a.ts"), "const a = 1;\n");
  }
  return dir;
}

const OK = `
task: "Count the things."
tools: [read_file, grep]
oracle:
  status: ok
  summary_must_match: ["\\\\b9\\\\b"]
  summary_must_not_match: ["\\\\b11\\\\b"]
`;

describe("loadFixture", () => {
  it("loads a valid read fixture", async () => {
    const dir = makeFixture(OK);
    try {
      const fx = await loadFixture(dir);
      expect(fx.task).toBe("Count the things.");
      expect(fx.tools).toEqual(["read_file", "grep"]);
      expect(fx.checks).toEqual([]);
      expect(fx.oracle.summary_must_match).toEqual(["\\b9\\b"]);
      expect(fx.name).toBe(dir.split("/").pop());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("loads checks and accepts run_checks in tools", async () => {
    const dir = makeFixture(`
task: "Fix it."
tools: [read_file, edit_file, run_checks]
checks:
  - { name: tests, cmd: "bun test" }
oracle: { checks_pass: true }
`);
    try {
      const fx = await loadFixture(dir);
      expect(fx.checks).toEqual([{ name: "tests", cmd: "bun test" }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects a missing task", async () => {
    const dir = makeFixture('tools: [read_file]\noracle: { status: ok }\n');
    try {
      await expect(loadFixture(dir)).rejects.toThrow(/task/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects an unknown tool, naming the knowns", async () => {
    const dir = makeFixture('task: t\ntools: [telepathy]\noracle: { status: ok }\n');
    try {
      await expect(loadFixture(dir)).rejects.toThrow(/telepathy.*read_file/s);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects an oracle regex that does not compile", async () => {
    const dir = makeFixture('task: t\ntools: [read_file]\noracle: { summary_must_match: ["([unclosed"] }\n');
    try {
      await expect(loadFixture(dir)).rejects.toThrow(/regex/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects a fixture without a files/ directory", async () => {
    const dir = makeFixture(OK, false);
    try {
      await expect(loadFixture(dir)).rejects.toThrow(/files\//);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("loads both committed fixtures", async () => {
    const routes = await loadFixture("bench/fixtures/routes-recall");
    expect(routes.oracle.summary_must_match!.length).toBeGreaterThanOrEqual(3);
    const greet = await loadFixture("bench/fixtures/greet-typo");
    expect(greet.oracle.checks_pass).toBe(true);
    expect(greet.oracle.files_changed).toEqual(["src/greet.ts"]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test tests/bench/fixture.test.ts`
Expected: FAIL — cannot resolve `../../src/bench/fixture`.

- [ ] **Step 3: Create `src/bench/fixture.ts`**

```ts
import { existsSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { validateChecks, type CheckConfig } from "../config";
import { ALL_TOOLS } from "../tools/registry";
import { RUN_CHECKS_NAME } from "../tools/checks";

export interface FixtureOracle {
  /** Expected envelope status, e.g. "ok". Omit to accept any. */
  status?: string;
  /** Require the overall gate verdict. */
  checks_pass?: boolean;
  /** Exact expected files_changed, order-insensitive. */
  files_changed?: string[];
  /** Regex sources the summary must match — citations, required findings. */
  summary_must_match?: string[];
  /** Regex sources the summary must NOT match — fabrication traps. */
  summary_must_not_match?: string[];
}

export interface Fixture {
  name: string;
  /** Absolute fixture directory; files/ lives inside. */
  dir: string;
  task: string;
  tools: string[];
  checks: CheckConfig[];
  oracle: FixtureOracle;
}

function stringList(raw: unknown, where: string): string[] {
  if (!Array.isArray(raw) || raw.some((s) => typeof s !== "string")) {
    throw new Error(`${where} must be a list of strings`);
  }
  return raw as string[];
}

/** Load and validate one fixture directory. Every problem names the fixture. */
export async function loadFixture(dir: string): Promise<Fixture> {
  const abs = resolve(dir);
  const name = basename(abs);
  const where = `fixture '${name}'`;
  const yamlPath = join(abs, "fixture.yaml");
  if (!existsSync(yamlPath)) throw new Error(`${where}: no fixture.yaml in ${abs}`);
  const raw = Bun.YAML.parse(await Bun.file(yamlPath).text()) as Record<string, unknown> | null;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`${where}: fixture.yaml must be a mapping`);
  }

  if (typeof raw["task"] !== "string" || !raw["task"]) throw new Error(`${where}: missing 'task'`);
  const tools = stringList(raw["tools"], `${where}: tools`);
  const knowns = [...Object.keys(ALL_TOOLS), RUN_CHECKS_NAME];
  for (const t of tools) {
    if (!knowns.includes(t)) {
      throw new Error(`${where}: unknown tool '${t}'. available: ${knowns.join(", ")}`);
    }
  }
  const checks = raw["checks"] === undefined ? [] : validateChecks(raw["checks"], where);

  const rawOracle = raw["oracle"];
  if (rawOracle === null || typeof rawOracle !== "object" || Array.isArray(rawOracle)) {
    throw new Error(`${where}: missing 'oracle' mapping`);
  }
  const o = rawOracle as Record<string, unknown>;
  const oracle: FixtureOracle = {};
  if (o["status"] !== undefined) oracle.status = String(o["status"]);
  if (o["checks_pass"] !== undefined) oracle.checks_pass = o["checks_pass"] === true;
  if (o["files_changed"] !== undefined) {
    oracle.files_changed = stringList(o["files_changed"], `${where}: oracle.files_changed`);
  }
  for (const key of ["summary_must_match", "summary_must_not_match"] as const) {
    if (o[key] === undefined) continue;
    const sources = stringList(o[key], `${where}: oracle.${key}`);
    for (const src of sources) {
      try {
        new RegExp(src);
      } catch (e) {
        throw new Error(
          `${where}: oracle.${key} regex ${JSON.stringify(src)} does not compile: ` +
            `${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
    oracle[key] = sources;
  }

  const files = join(abs, "files");
  if (!existsSync(files) || !statSync(files).isDirectory()) {
    throw new Error(`${where}: missing files/ directory — the repo the delegate works in`);
  }

  return { name, dir: abs, task: raw["task"], tools, checks, oracle };
}
```

- [ ] **Step 4: Create the committed fixtures**

`bench/fixtures/routes-recall/fixture.yaml`:

```yaml
# Read-loop fixture ported from the 2026-08-06 lan-host bench. Ground truth by
# grep: lines 9, 10, 12 validate. The must-not list is the fabrication trap.
task: "List every route in src/routes.ts that validates its request body, with the exact line number of each."
tools: [read_file, grep, glob, list_dir]
oracle:
  status: ok
  summary_must_match: ["\\b9\\b", "\\b10\\b", "\\b12\\b"]
  summary_must_not_match: ["[Ll]ine\\s*8\\b", "[Ll]ine\\s*11\\b", "[Ll]ine\\s*13\\b"]
```

`bench/fixtures/routes-recall/files/src/routes.ts` and `files/src/zod-stub.ts`: exactly the 2026-08-06 bench fixture contents (the six-route file with three `.parse(req.body)` handlers at lines 9/10/12, and the one-line zod stub — copy from `docs/bench/2026-08-06-lan-host.md`'s described fixture; the route file's content is reproduced in the bench doc's method section and in this repo's git history of the session scratchpad; recreate it verbatim so the line numbers land on 9/10/12 and verify with `grep -n "parse(req.body)"`).

`bench/fixtures/greet-typo/fixture.yaml`:

```yaml
# Write-loop fixture: one-line typo fix, gated. The oracle is the gate.
task: "greet() in src/greet.ts returns 'Helo, ...' — a typo. Fix it so it returns 'Hello, ...'. Change nothing else."
tools: [read_file, grep, edit_file, run_checks]
checks:
  - { name: tests, cmd: "grep -q 'Hello' src/greet.ts" }
oracle:
  status: ok
  checks_pass: true
  files_changed: ["src/greet.ts"]
```

`bench/fixtures/greet-typo/files/src/greet.ts`:

```ts
export function greet(name: string): string {
  return `Helo, ${name}!`;
}

export function farewell(name: string): string {
  return `Goodbye, ${name}.`;
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun test tests/bench/fixture.test.ts` — PASS, 7 tests (including the committed-fixtures load). Verify `grep -n "parse(req.body)" bench/fixtures/routes-recall/files/src/routes.ts` prints lines 9, 10, 12.

- [ ] **Step 6: Typecheck, then commit**

```bash
git add src/bench/fixture.ts bench/fixtures tests/bench/fixture.test.ts
git commit -m "feat: bench fixtures — a directory, a task, an oracle

A fixture is what the delegate gets (files/, task, tools, checks) plus
what must be true afterward (status, gate verdict, citation regexes,
fabrication traps, exact files_changed). The two committed fixtures port
the first live bench, so the suite's first baseline is numbers already
trusted. Every validation failure names the fixture."
```

---

### Task 10: Runner and scorer — `executeRun` in-process

Copy `files/` into a throwaway git repo (committed — the RED state the worktree will see), synthesize a profile into the caller's config, run `executeRun` directly, score the envelope against the oracle.

**Files:**
- Create: `src/bench/score.ts`
- Create: `src/bench/run.ts`
- Test: `tests/bench/score.test.ts`
- Test: `tests/bench/run.test.ts`

**Interfaces:**
- Consumes: `Fixture` from `src/bench/fixture.ts`; `Envelope` from `src/envelope.ts`; `Config`, `resolveProfile` from `src/config.ts`; `executeRun` from `src/run.ts`.
- Produces: `scoreEnvelope(fx: Fixture, env: Envelope): { pass: boolean; failures: string[] }`; `interface BenchRow { fixture: string; tier: string; model: string; status: string; gatePassed: boolean | null; oraclePass: boolean; failures: string[]; turns: number; wallSecs: number; tokens: number; truncations: number }`; `runFixture(fx: Fixture, tierName: string, cfg: Config, opts?: { deadlineSecs?: number; logDir?: string }): Promise<{ row: BenchRow; envelope: Envelope }>`. Task 11's CLI drives them.

- [ ] **Step 1: Write the failing tests**

Create `tests/bench/score.test.ts`:

```ts
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
```

Create `tests/bench/run.test.ts`:

```ts
import { describe, it, expect, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig } from "../../src/config";
import { loadFixture } from "../../src/bench/fixture";
import { runFixture } from "../../src/bench/run";

/** Fake model that answers with the routes fixture's ground truth. */
function serveAnswer(text: string): { url: string; stop(): void } {
  const server = Bun.serve({
    port: 0,
    fetch: () => Response.json({
      choices: [{ message: { role: "assistant", content: text }, finish_reason: "stop" }],
      usage: { prompt_tokens: 50, completion_tokens: 10 },
    }),
  });
  return { url: `http://127.0.0.1:${server.port}/v1`, stop: () => server.stop(true) };
}

const cleanups: string[] = [];
afterEach(() => { for (const d of cleanups.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe("runFixture", () => {
  it("copies files into a throwaway repo, runs in-process, and scores", async () => {
    const srv = serveAnswer("Validating routes: line 9, line 10, line 12.");
    try {
      const cfg = parseConfig(`
providers:
  test: { base_url: "${srv.url}" }
tiers:
  cheap: { provider: test, model: "fake-model" }
profiles:
  unused: { tools: [read_file], tier: cheap }
`);
      const fx = await loadFixture("bench/fixtures/routes-recall");
      const { row, envelope } = await runFixture(fx, "cheap", cfg, { deadlineSecs: 60 });
      expect(envelope.status).toBe("ok");
      expect(row).toMatchObject({
        fixture: "routes-recall", tier: "cheap", model: "fake-model",
        status: "ok", oraclePass: true, failures: [], gatePassed: null,
      });
      expect(row.turns).toBe(1);
      expect(row.tokens).toBe(60);
    } finally {
      srv.stop();
    }
  });

  it("fails the oracle when the answer fabricates, and says why", async () => {
    const srv = serveAnswer("Line 9 and line 11 validate.");
    try {
      const cfg = parseConfig(`
providers:
  test: { base_url: "${srv.url}" }
tiers:
  cheap: { provider: test, model: "fake-model" }
profiles:
  unused: { tools: [read_file], tier: cheap }
`);
      const fx = await loadFixture("bench/fixtures/routes-recall");
      const { row } = await runFixture(fx, "cheap", cfg, { deadlineSecs: 60 });
      expect(row.oraclePass).toBe(false);
      expect(row.failures.join(" ")).toMatch(/must_not_match|must_match/);
    } finally {
      srv.stop();
    }
  });

  it("never touches the fixture's own files/ directory", async () => {
    const srv = serveAnswer("done");
    try {
      const cfg = parseConfig(`
providers:
  test: { base_url: "${srv.url}" }
tiers:
  cheap: { provider: test, model: "fake-model" }
profiles:
  unused: { tools: [read_file], tier: cheap }
`);
      const fx = await loadFixture("bench/fixtures/greet-typo");
      const before = await Bun.file("bench/fixtures/greet-typo/files/src/greet.ts").text();
      await runFixture(fx, "cheap", cfg, { deadlineSecs: 60 });
      const after = await Bun.file("bench/fixtures/greet-typo/files/src/greet.ts").text();
      expect(after).toBe(before);
    } finally {
      srv.stop();
    }
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test tests/bench/score.test.ts tests/bench/run.test.ts`
Expected: FAIL — modules missing.

- [ ] **Step 3: Create `src/bench/score.ts`**

```ts
import type { Envelope } from "../envelope";
import type { Fixture } from "./fixture";

export interface BenchRow {
  fixture: string;
  tier: string;
  model: string;
  status: string;
  /** null when the fixture has no checks — nothing gated. */
  gatePassed: boolean | null;
  oraclePass: boolean;
  failures: string[];
  turns: number;
  wallSecs: number;
  tokens: number;
  truncations: number;
}

/** Score one envelope against one oracle. Collects every failure — a bench
 * row that says only "failed" teaches nothing. */
export function scoreEnvelope(fx: Fixture, env: Envelope): { pass: boolean; failures: string[] } {
  const failures: string[] = [];
  const o = fx.oracle;

  if (o.status !== undefined && env.status !== o.status) {
    failures.push(`status: expected '${o.status}', got '${env.status}'`);
  }
  if (o.checks_pass !== undefined) {
    const passed = env.test?.passed ?? false;
    if (passed !== o.checks_pass) {
      failures.push(`checks_pass: expected ${o.checks_pass}, gate says ${env.test?.passed ?? "never ran"}`);
    }
  }
  if (o.files_changed !== undefined) {
    const got = [...(env.files_changed ?? [])].sort();
    const want = [...o.files_changed].sort();
    if (JSON.stringify(got) !== JSON.stringify(want)) {
      failures.push(`files_changed: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
    }
  }
  const summary = env.summary ?? "";
  for (const src of o.summary_must_match ?? []) {
    if (!new RegExp(src).test(summary)) failures.push(`summary_must_match missed: ${src}`);
  }
  for (const src of o.summary_must_not_match ?? []) {
    if (new RegExp(src).test(summary)) failures.push(`summary_must_not_match hit: ${src}`);
  }
  return { pass: failures.length === 0, failures };
}
```

- [ ] **Step 4: Create `src/bench/run.ts`**

```ts
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../config";
import { resolveProfile } from "../config";
import { executeRun } from "../run";
import type { Envelope } from "../envelope";
import type { Fixture } from "./fixture";
import { scoreEnvelope, type BenchRow } from "./score";

async function sh(cwd: string, ...cmd: string[]): Promise<void> {
  const proc = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  if ((await proc.exited) !== 0) {
    throw new Error(`${cmd.join(" ")} failed: ${await new Response(proc.stderr).text()}`);
  }
}

/**
 * Run one fixture on one tier, in-process through executeRun — the bench
 * measures the same code path a real orchestrator pays for, minus only the
 * CLI's argv parsing. The fixture's files are copied into a throwaway git
 * repo and committed: write profiles get their worktree, and the committed
 * state IS the RED state the delegate sees.
 */
export async function runFixture(
  fx: Fixture,
  tierName: string,
  cfg: Config,
  opts: { deadlineSecs?: number; logDir?: string } = {},
): Promise<{ row: BenchRow; envelope: Envelope }> {
  // Synthetic profile: fixtures carry tools/checks; config carries
  // providers/tiers/sampling. resolveProfile does every validation both ways.
  const cfgWithFixture: Config = {
    ...cfg,
    profiles: {
      ...cfg.profiles,
      __bench: {
        tools: fx.tools,
        tier: tierName,
        ...(fx.checks.length > 0 ? { checks: fx.checks } : {}),
      },
    },
  };
  const run = resolveProfile(cfgWithFixture, "__bench");

  const root = mkdtempSync(join(tmpdir(), `subagents-bench-${fx.name}-`));
  try {
    cpSync(join(fx.dir, "files"), root, { recursive: true });
    await sh(root, "git", "init", "-q");
    await sh(root, "git", "config", "user.email", "bench@subagents");
    await sh(root, "git", "config", "user.name", "bench");
    await sh(root, "git", "config", "commit.gpgsign", "false");
    await sh(root, "git", "add", "-A");
    await sh(root, "git", "commit", "-qm", "fixture");

    const started = Date.now();
    const { envelope } = await executeRun({
      run,
      task: fx.task,
      root,
      transcriptPath: join(root, ".bench-transcript.json"),
      ...(opts.deadlineSecs !== undefined
        ? { deadlineAt: started + opts.deadlineSecs * 1000 }
        : {}),
      ...(opts.logDir !== undefined
        ? { logPath: join(opts.logDir, `${fx.name}.${tierName}.log.jsonl`) }
        : {}),
    });

    const verdict = scoreEnvelope(fx, envelope);
    const row: BenchRow = {
      fixture: fx.name,
      tier: tierName,
      model: run.model,
      status: envelope.status,
      gatePassed: fx.checks.length > 0 ? (envelope.test?.passed ?? false) : null,
      oraclePass: verdict.pass,
      failures: verdict.failures,
      turns: envelope.turns,
      wallSecs: envelope.wall_secs,
      tokens: envelope.local_tokens,
      truncations: envelope.truncations,
    };
    return { row, envelope };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun test tests/bench/score.test.ts tests/bench/run.test.ts` — PASS. Then the whole suite.

- [ ] **Step 6: Typecheck, then commit**

```bash
git add src/bench/score.ts src/bench/run.ts tests/bench/score.test.ts tests/bench/run.test.ts
git commit -m "feat: bench runner scores executeRun in-process

The bench measures the exact code path an orchestrator pays for — same
loop, same worktree lifecycle, same gate — minus only argv parsing. Every
oracle failure is named (the missed regex, the trap that fired, the
files_changed delta): a row that says only 'failed' teaches nothing."
```

---

### Task 11: `subagents bench` — CLI and baseline compare

Fail-fast like batch: every fixture loads and every (fixture, tier) resolves before anything runs. Rows stream to stderr as a table; JSONL to `--out`; `--baseline` turns the run into a regression gate.

**Files:**
- Modify: `src/cli.ts`
- Modify: `.gitignore`
- Test: `tests/cli-bench.test.ts` (create)

**Interfaces:**
- Consumes: `loadFixture`, `runFixture`, `BenchRow`.
- Produces: the `bench` command: `subagents bench --fixtures <glob> --tiers <a,b> [--config <path>] [--out <path>] [--baseline <path>] [--deadline-secs <n>] [--log-dir <dir>]`. Exit 0 = ran (oracle failures are data, not errors); exit 2 = regression against `--baseline`; exit 1 = never started.

- [ ] **Step 1: Write the failing tests**

Create `tests/cli-bench.test.ts`:

```ts
import { describe, it, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(import.meta.dir, "..", "src", "cli.ts");

function serveAnswer(text: string): { url: string; stop(): void } {
  const server = Bun.serve({
    port: 0,
    fetch: () => Response.json({
      choices: [{ message: { role: "assistant", content: text }, finish_reason: "stop" }],
      usage: { prompt_tokens: 50, completion_tokens: 10 },
    }),
  });
  return { url: `http://127.0.0.1:${server.port}/v1`, stop: () => server.stop(true) };
}

function benchConfig(url: string): string {
  const dir = mkdtempSync(join(tmpdir(), "subagents-benchcfg-"));
  const path = join(dir, "subagents.yaml");
  writeFileSync(path, `
providers:
  test: { base_url: "${url}" }
tiers:
  cheap: { provider: test, model: "fake-model" }
profiles:
  unused: { tools: [read_file], tier: cheap }
`);
  return path;
}

async function runBench(args: string[]): Promise<{ code: number; out: string; err: string }> {
  const proc = Bun.spawn(["bun", CLI, "bench", ...args], { stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code: await proc.exited, out, err };
}

const cleanups: string[] = [];
afterEach(() => { for (const d of cleanups.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe("subagents bench", () => {
  it("runs the fixture glob and writes scored JSONL rows", async () => {
    const srv = serveAnswer("Validating: line 9, line 10, line 12.");
    const outDir = mkdtempSync(join(tmpdir(), "subagents-benchout-"));
    cleanups.push(outDir);
    try {
      const cfg = benchConfig(srv.url);
      cleanups.push(join(cfg, ".."));
      const out = join(outDir, "results.jsonl");
      const r = await runBench([
        "--fixtures", "bench/fixtures/routes-recall", "--tiers", "cheap",
        "--config", cfg, "--out", out, "--deadline-secs", "60"]);
      expect(r.code).toBe(0);
      expect(r.err).toContain("routes-recall");
      const rows = (await Bun.file(out).text()).trim().split("\n").map((l) => JSON.parse(l));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        fixture: "routes-recall", tier: "cheap", oraclePass: true,
      });
    } finally {
      srv.stop();
    }
  });

  it("exits 2 naming the regression when a baseline row flips to fail", async () => {
    const srv = serveAnswer("I found line 11 only."); // trap hit + misses
    const outDir = mkdtempSync(join(tmpdir(), "subagents-benchout-"));
    cleanups.push(outDir);
    try {
      const cfg = benchConfig(srv.url);
      cleanups.push(join(cfg, ".."));
      const baseline = join(outDir, "baseline.jsonl");
      writeFileSync(baseline,
        `${JSON.stringify({ fixture: "routes-recall", tier: "cheap", oraclePass: true })}\n`);
      const r = await runBench([
        "--fixtures", "bench/fixtures/routes-recall", "--tiers", "cheap",
        "--config", cfg, "--out", join(outDir, "results.jsonl"),
        "--baseline", baseline, "--deadline-secs", "60"]);
      expect(r.code).toBe(2);
      expect(r.err).toMatch(/REGRESSION.*routes-recall/s);
    } finally {
      srv.stop();
    }
  });

  it("fails fast on an unknown tier before running anything", async () => {
    const srv = serveAnswer("x");
    try {
      const cfg = benchConfig(srv.url);
      cleanups.push(join(cfg, ".."));
      const r = await runBench([
        "--fixtures", "bench/fixtures/routes-recall", "--tiers", "ghost", "--config", cfg]);
      expect(r.code).toBe(1);
      expect(r.out).toBe("");
      expect(r.err).toContain("ghost");
    } finally {
      srv.stop();
    }
  });

  it("fails fast when the glob matches no fixture", async () => {
    const srv = serveAnswer("x");
    try {
      const cfg = benchConfig(srv.url);
      cleanups.push(join(cfg, ".."));
      const r = await runBench(["--fixtures", "bench/fixtures/nonexistent-*", "--tiers", "cheap", "--config", cfg]);
      expect(r.code).toBe(1);
      expect(r.err).toContain("no fixtures");
    } finally {
      srv.stop();
    }
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test tests/cli-bench.test.ts`
Expected: FAIL — `unknown command 'bench'`.

- [ ] **Step 3: Add `benchMain` to `src/cli.ts`**

1. Imports: `loadFixture` from `./bench/fixture`, `runFixture` from `./bench/run`, `type BenchRow` from `./bench/score`.
2. `BENCH_STRING_OPTS = new Set(["fixtures", "tiers", "config", "out", "baseline", "deadline-secs", "log-dir"])`; dispatch in `main` gains `if (command === "bench") return benchMain(argv.slice(1));`; USAGE gains a `subagents bench` line and an options block mirroring the flags (one line each, noting exit 2 = baseline regression and that oracle failures alone exit 0 — bench is measurement, not CI, until a baseline says otherwise).
3. `benchMain`:

```ts
async function benchMain(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: normalizeArgv(argv, BENCH_STRING_OPTS),
    options: {
      fixtures: { type: "string", default: "bench/fixtures/*" },
      tiers: { type: "string" },
      config: { type: "string" },
      out: { type: "string", default: "bench/results.jsonl" },
      baseline: { type: "string" },
      "deadline-secs": { type: "string" },
      "log-dir": { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: false,
  });
  if (values.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (!values.tiers) {
    process.stderr.write(`missing required --tiers\n\n${USAGE}`);
    return 1;
  }
  let deadlineSecs: number | undefined;
  if (values["deadline-secs"] !== undefined) {
    deadlineSecs = Number(values["deadline-secs"]);
    if (!Number.isFinite(deadlineSecs) || deadlineSecs <= 0) {
      process.stderr.write(`--deadline-secs must be a positive number\n`);
      return 1;
    }
  }

  // Fail-fast zone: load every fixture, resolve every (fixture, tier) pair,
  // and read the baseline before anything runs — a typo'd tier discovered
  // on fixture 12 of 12 wastes the first 11.
  const cfg = parseConfig(await Bun.file(findConfig(values.config)).text());
  // A literal directory path is a valid --fixtures value too — globs with
  // no wildcard don't reliably match directories in every scanner.
  const dirs = existsSync(join(values.fixtures, "fixture.yaml"))
    ? [values.fixtures]
    : [...new Bun.Glob(values.fixtures).scanSync({ onlyFiles: false })]
        .filter((d) => existsSync(join(d, "fixture.yaml"))).sort();
  if (dirs.length === 0) {
    process.stderr.write(`no fixtures match ${values.fixtures}\n`);
    return 1;
  }
  const fixtures = [];
  for (const d of dirs) fixtures.push(await loadFixture(d));
  const tiers = values.tiers.split(",").map((t) => t.trim()).filter(Boolean);
  for (const fx of fixtures) {
    for (const tier of tiers) {
      resolveProfile(
        { ...cfg, profiles: { ...cfg.profiles, __bench: {
          tools: fx.tools, tier, ...(fx.checks.length ? { checks: fx.checks } : {}),
        } } },
        "__bench",
      );
    }
  }
  let baseline: Map<string, boolean> | undefined;
  if (values.baseline !== undefined) {
    baseline = new Map(
      (await Bun.file(values.baseline).text()).trim().split("\n").filter(Boolean)
        .map((l) => JSON.parse(l) as BenchRow)
        .map((r) => [`${r.fixture} ${r.tier}`, r.oraclePass]));
  }
  if (values["log-dir"] !== undefined) mkdirSync(values["log-dir"], { recursive: true });
  mkdirSync(resolve(values.out, ".."), { recursive: true });

  const rows: BenchRow[] = [];
  const regressions: string[] = [];
  let outText = "";
  for (const tier of tiers) {           // tier-major: each model loads once
    for (const fx of fixtures) {
      const { row } = await runFixture(fx, tier, cfg, {
        ...(deadlineSecs !== undefined ? { deadlineSecs } : {}),
        ...(values["log-dir"] !== undefined ? { logDir: values["log-dir"] } : {}),
      });
      rows.push(row);
      outText += `${JSON.stringify(row)}\n`;
      process.stderr.write(
        `${row.fixture.padEnd(24)} ${row.tier.padEnd(10)} ` +
        `${(row.oraclePass ? "PASS" : "FAIL").padEnd(5)} status=${row.status} ` +
        `turns=${row.turns} wall=${row.wallSecs}s tokens=${row.tokens}` +
        `${row.failures.length ? `\n  ${row.failures.join("\n  ")}` : ""}\n`);
      const key = `${row.fixture} ${row.tier}`;
      if (baseline?.get(key) === true && !row.oraclePass) {
        regressions.push(`${row.fixture} (${row.tier})`);
      }
    }
  }
  await Bun.write(values.out, outText);

  if (regressions.length > 0) {
    process.stderr.write(`\nREGRESSION vs baseline: ${regressions.join(", ")}\n`);
    return 2;
  }
  return 0;
}
```

4. `.gitignore` gains:

```
bench/results.jsonl
bench/fixtures-exercism/
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test tests/cli-bench.test.ts` — PASS, 4 tests. Then whole suite + typecheck.

- [ ] **Step 5: Commit**

```bash
git add src/cli.ts .gitignore tests/cli-bench.test.ts
git commit -m "feat: subagents bench — fixtures scored, baselines gated

Fail-fast like batch (every fixture and tier resolves before anything
runs), tier-major so each model loads once, rows streamed as a table and
persisted as JSONL. Oracle failures are data and exit 0; only a baseline
flip is an error — the bench is measurement first, CI gate when asked."
```

---

### Task 12: Exercism importer — validated, gitignored, never vendored

Hundreds of standardized write-loop tasks with pre-written oracles. Each import is proven before it exists: the exercise's canonical solution must pass its own tests under `bun test`, or the exercise is skipped with a logged reason.

**Files:**
- Create: `src/bench/import-exercism.ts`
- Test: `tests/bench/import.test.ts`

**Interfaces:**
- Consumes: `git` CLI, `bun test` (subprocess), the Exercism track repo layout (`exercises/practice/<slug>/`, `.meta/config.json` with `files.solution`/`files.test`/`files.exemplar`).
- Produces: `importTrack(trackDir: string, dest: string, opts?: { count?: number; slugs?: string[] }): Promise<{ imported: string[]; skipped: Array<{ slug: string; reason: string }> }>` (exported, network-free — the testable core) and a CLI entry (`bun src/bench/import-exercism.ts --track typescript --count 10 [--dest bench/fixtures-exercism] [--slugs a,b]`) that shallow-clones `https://github.com/exercism/<track>` to a temp dir and calls it.

- [ ] **Step 1: Write the failing tests**

Create `tests/bench/import.test.ts` — builds a fake track layout, no network:

```ts
import { describe, it, expect, afterEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importTrack } from "../../src/bench/import-exercism";
import { loadFixture } from "../../src/bench/fixture";

function fakeTrack(): string {
  const dir = mkdtempSync(join(tmpdir(), "subagents-track-"));
  // A solvable exercise: exemplar passes its test.
  const good = join(dir, "exercises", "practice", "two-fer");
  mkdirSync(join(good, ".meta"), { recursive: true });
  writeFileSync(join(good, "two-fer.ts"),
    "export function twoFer(name?: string): string {\n  throw new Error('implement');\n}\n");
  writeFileSync(join(good, "two-fer.test.ts"), `
import { describe, it, expect } from "bun:test";
import { twoFer } from "./two-fer";
describe("twoFer", () => {
  it("defaults to you", () => expect(twoFer()).toBe("One for you, one for me."));
  it("names names", () => expect(twoFer("Alice")).toBe("One for Alice, one for me."));
});
`);
  writeFileSync(join(good, ".meta", "exemplar.ts"),
    'export function twoFer(name = "you"): string {\n  return `One for ${name}, one for me.`;\n}\n');
  writeFileSync(join(good, ".meta", "config.json"), JSON.stringify({
    files: { solution: ["two-fer.ts"], test: ["two-fer.test.ts"], exemplar: [".meta/exemplar.ts"] },
  }));
  writeFileSync(join(good, "README.md"), "# Two Fer\nReturn 'One for X, one for me.'\n");

  // A broken exercise: exemplar does NOT pass (wrong expected string).
  const bad = join(dir, "exercises", "practice", "broken-ex");
  mkdirSync(join(bad, ".meta"), { recursive: true });
  writeFileSync(join(bad, "broken-ex.ts"), "export const x = () => 0;\n");
  writeFileSync(join(bad, "broken-ex.test.ts"), `
import { it, expect } from "bun:test";
import { x } from "./broken-ex";
it("wants 1", () => expect(x()).toBe(1));
`);
  writeFileSync(join(bad, ".meta", "exemplar.ts"), "export const x = () => 0;\n");
  writeFileSync(join(bad, ".meta", "config.json"), JSON.stringify({
    files: { solution: ["broken-ex.ts"], test: ["broken-ex.test.ts"], exemplar: [".meta/exemplar.ts"] },
  }));
  writeFileSync(join(bad, "README.md"), "# Broken\n");
  return dir;
}

const cleanups: string[] = [];
afterEach(() => { for (const d of cleanups.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe("importTrack", () => {
  it("imports the solvable exercise as a loadable fixture and skips the broken one, with reasons", async () => {
    const track = fakeTrack();
    const dest = mkdtempSync(join(tmpdir(), "subagents-imp-"));
    cleanups.push(track, dest);

    const r = await importTrack(track, dest);
    expect(r.imported).toEqual(["two-fer"]);
    expect(r.skipped).toHaveLength(1);
    expect(r.skipped[0]!.slug).toBe("broken-ex");
    expect(r.skipped[0]!.reason).toMatch(/exemplar.*fail/i);

    const fx = await loadFixture(join(dest, "two-fer"));
    expect(fx.task).toContain("README");
    expect(fx.tools).toContain("edit_file");
    expect(fx.tools).toContain("run_checks");
    expect(fx.checks).toEqual([{ name: "tests", cmd: "bun test" }]);
    expect(fx.oracle.checks_pass).toBe(true);
    // The fixture ships the STUB, not the exemplar — the task is unsolved.
    const stub = await Bun.file(join(dest, "two-fer", "files", "two-fer.ts")).text();
    expect(stub).toContain("implement");
    // No .meta leakage: the exemplar must not ride along as a crib.
    expect(existsSync(join(dest, "two-fer", "files", ".meta"))).toBe(false);
  });

  it("honors a slug filter", async () => {
    const track = fakeTrack();
    const dest = mkdtempSync(join(tmpdir(), "subagents-imp-"));
    cleanups.push(track, dest);
    const r = await importTrack(track, dest, { slugs: ["broken-ex"] });
    expect(r.imported).toEqual([]);
    expect(r.skipped).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test tests/bench/import.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Create `src/bench/import-exercism.ts`**

```ts
import {
  cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { parseArgs } from "node:util";

interface MetaConfig {
  files?: { solution?: string[]; test?: string[]; exemplar?: string[] };
}

async function bunTestPasses(dir: string): Promise<boolean> {
  const proc = Bun.spawn(["bun", "test"], { cwd: dir, stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => proc.kill(9), 30_000);
  const code = await proc.exited;
  clearTimeout(timer);
  return code === 0;
}

/**
 * Import practice exercises from a local checkout of an Exercism track into
 * bench fixtures. Every import is proven before it exists: the exercise's
 * own canonical solution (exemplar) must pass its own tests under
 * `bun test`, or the exercise is skipped with a reason — a fixture whose
 * oracle cannot go green is not a benchmark, it is a trap.
 * Network-free by design; the CLI entry below does the cloning.
 */
export async function importTrack(
  trackDir: string,
  dest: string,
  opts: { count?: number; slugs?: string[] } = {},
): Promise<{ imported: string[]; skipped: Array<{ slug: string; reason: string }> }> {
  const practiceDir = join(trackDir, "exercises", "practice");
  if (!existsSync(practiceDir)) {
    throw new Error(`not an Exercism track checkout: ${practiceDir} missing`);
  }
  let slugs = readdirSync(practiceDir).sort();
  if (opts.slugs) slugs = slugs.filter((s) => opts.slugs!.includes(s));

  const imported: string[] = [];
  const skipped: Array<{ slug: string; reason: string }> = [];

  for (const slug of slugs) {
    if (opts.count !== undefined && imported.length >= opts.count) break;
    const src = join(practiceDir, slug);
    const metaPath = join(src, ".meta", "config.json");
    if (!existsSync(metaPath)) {
      skipped.push({ slug, reason: "no .meta/config.json" });
      continue;
    }
    const meta = JSON.parse(await Bun.file(metaPath).text()) as MetaConfig;
    const solutions = meta.files?.solution ?? [];
    const tests = meta.files?.test ?? [];
    const exemplars = meta.files?.exemplar ?? [];
    if (solutions.length === 0 || tests.length === 0 || exemplars.length !== solutions.length) {
      skipped.push({ slug, reason: "unusable .meta files layout" });
      continue;
    }

    // Prove the oracle: exemplar over stub, then bun test must pass.
    const proof = mkdtempSync(join(tmpdir(), `subagents-exemplar-${slug}-`));
    try {
      for (const t of tests) {
        mkdirSync(join(proof, dirname(t)), { recursive: true });
        cpSync(join(src, t), join(proof, t));
      }
      for (let i = 0; i < solutions.length; i++) {
        mkdirSync(join(proof, dirname(solutions[i]!)), { recursive: true });
        cpSync(join(src, exemplars[i]!), join(proof, solutions[i]!));
      }
      if (!(await bunTestPasses(proof))) {
        skipped.push({ slug, reason: "exemplar fails under bun test (jest-compat gap)" });
        continue;
      }
    } finally {
      rmSync(proof, { recursive: true, force: true });
    }

    // Emit the fixture: stub + tests + README, never .meta (no cribs).
    const fxDir = join(dest, slug);
    rmSync(fxDir, { recursive: true, force: true });
    const filesDir = join(fxDir, "files");
    for (const f of [...solutions, ...tests]) {
      mkdirSync(join(filesDir, dirname(f)), { recursive: true });
      cpSync(join(src, f), join(filesDir, f));
    }
    if (existsSync(join(src, "README.md"))) {
      cpSync(join(src, "README.md"), join(filesDir, "README.md"));
    }
    writeFileSync(join(fxDir, "fixture.yaml"), [
      `# Imported from Exercism (${slug}); oracle proven via exemplar. Not vendored — regenerate with import-exercism.`,
      `task: "Implement the exercise described in README.md so the tests pass. The test file names the entry points."`,
      `tools: [read_file, grep, list_dir, edit_file, write_file, run_checks]`,
      `checks:`,
      `  - { name: tests, cmd: "bun test" }`,
      `oracle:`,
      `  status: ok`,
      `  checks_pass: true`,
      ``,
    ].join("\n"));
    imported.push(slug);
  }

  return { imported, skipped };
}

// CLI entry: clone-then-import. Kept thin so tests never need the network.
if (import.meta.main) {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      track: { type: "string", default: "typescript" },
      count: { type: "string", default: "10" },
      dest: { type: "string", default: "bench/fixtures-exercism" },
      slugs: { type: "string" },
    },
  });
  const clone = mkdtempSync(join(tmpdir(), "subagents-exercism-"));
  const url = `https://github.com/exercism/${values.track}`;
  const proc = Bun.spawn(["git", "clone", "--depth", "1", url, clone],
    { stdout: "inherit", stderr: "inherit" });
  if ((await proc.exited) !== 0) {
    console.error(`clone failed: ${url}`);
    process.exit(1);
  }
  try {
    const r = await importTrack(clone, values.dest, {
      count: Number(values.count),
      ...(values.slugs ? { slugs: values.slugs.split(",") } : {}),
    });
    console.log(`imported ${r.imported.length}: ${r.imported.join(", ")}`);
    for (const s of r.skipped) console.log(`skipped ${s.slug}: ${s.reason}`);
  } finally {
    rmSync(clone, { recursive: true, force: true });
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test tests/bench/import.test.ts` — PASS, 2 tests. Then whole suite + typecheck.

- [ ] **Step 5: Commit**

```bash
git add src/bench/import-exercism.ts tests/bench/import.test.ts
git commit -m "feat: Exercism importer — every oracle proven before it exists

The exercise's canonical solution must pass its own tests under bun's
jest-compat, or the exercise is skipped with a logged reason: a fixture
whose oracle cannot go green is a trap, not a benchmark. Fixtures ship
the stub, the tests, and the README — never .meta, never a crib — into a
gitignored directory. Nothing is vendored; regenerate at will."
```

---

### Task 13: Documentation sweep B — the suite exists, with its caveat

**Files:**
- Create: `bench/README.md`
- Modify: `README.md`, `docs/design.md`, `CLAUDE.md`, `docs/wiki/Recommended-Models.md`

- [ ] **Step 1: Create `bench/README.md`**

```markdown
# subagents bench

Deterministic fixtures scored against oracles, run in-process through the
same `executeRun` an orchestrator pays for.

## The one rule for reading results

**This suite measures the harness, not the models.** Public exercises are
in every model's training data, so absolute scores are inflated and must
never be quoted as model capability. What stays valid: *relative deltas
across harness variants* — checks pipeline on vs off, a prompt change, a
truncation-cap change — because contamination is constant across them.

## Running

    subagents bench --tiers cheap,strong --config subagents.yaml \
      --out bench/results.jsonl [--baseline bench/baseline.jsonl] [--log-dir bench/logs]

Rows stream as a table; JSONL lands at `--out`. With `--baseline`, a
fixture that was passing and now fails exits 2 naming it. To pin a
baseline: run clean, then `cp bench/results.jsonl bench/baseline.jsonl`
and commit it.

## Fixtures

A fixture is a directory: `fixture.yaml` (task, tools, optional ordered
`checks`, oracle) plus `files/` — the repo the delegate works in, copied
to a throwaway git repo per run. Oracles: expected `status`, gate verdict
(`checks_pass`), exact `files_changed`, `summary_must_match` regexes
(citations), `summary_must_not_match` regexes (fabrication traps).

- `bench/fixtures/` — committed, hand-authored; read-loop metrics need
  planted ground truth.
- `bench/fixtures-exercism/` — generated by
  `bun src/bench/import-exercism.ts --track typescript --count 20`,
  gitignored, each oracle proven by running the exercise's canonical
  solution under `bun test` before the fixture is written.

## Logs

`--log-dir` writes per-turn JSONL (`{ts, turn, latencyMs, backendMs,
toolCalls, promptTokens, completionTokens, finishReason}`) — the same
format `subagents run --log` and every batch job emit, so one analysis
script serves bench runs and real workloads.
```

- [ ] **Step 2: Sweep the other surfaces**

- `README.md`: "What's planned, not built" drops the benchmark harness; "What ships today" gains one bullet: `subagents bench` — fixture suite with oracles, baseline regression gating, per-turn logs; **measures harness deltas, not model capability** (link `bench/README.md`).
- `docs/design.md`: Benchmark section marked shipped, updated to the fixture/oracle/baseline design as built; status paragraph updated (remaining: bash, MCP client, LM Studio adapter).
- `CLAUDE.md`: Commands gains `bun src/cli.ts bench --tiers cheap --config subagents.yaml` and the importer invocation; a line in "Where things are": `bench/` fixtures + README, results gitignored.
- `docs/wiki/Recommended-Models.md`: "Contributing measurements" gains one sentence pointing at the repo's bench suite as the preferred measurement vehicle (same task, same oracle, comparable rows).

- [ ] **Step 3: Verify and commit**

Checks: `bun test && bun run typecheck` (docs only — still green); every command named in docs exists (`bench`, importer flags); no doc claims absolute model rankings from the suite.

```bash
git add bench/README.md README.md docs/design.md CLAUDE.md docs/wiki/Recommended-Models.md
git commit -m "docs: the bench suite ships, carrying its own caveat

Every surface that names the suite states the rule that keeps its numbers
honest: it measures harness deltas — contamination is constant across
harness variants and fatal to capability claims. The wiki's contribution
path now points at fixtures, so shared measurements arrive comparable."
```

---

## Follow-on plans

Each produces working software on its own and depends only on this plan:

1. **`protected_paths`** — write profiles refuse config-declared globs (the structural fix for spec-test tampering; the `files_changed` rejection rule covers it until then).
2. **Auto-fix formatter stage** — a check stage flagged `fix: true` runs a formatter in the worktree post-green instead of coaching the model on whitespace.
3. **LM Studio adapter** — capability probe (closes the silently-served-unknown-model hazard the live bench found), residency control, real `context.limit`/`pressure`.
4. **MCP client**, **`bash` tool** — as previously designed.
5. **SWE-bench-Lite stretch tier** — real-issue fixtures for strong tiers once the Exercism suite is routine.

## Verification

After every task: `bun test && bun run typecheck`; the suite grows from 230.

**Phase A live check** (LM Studio on lan-host, `subagents.yaml` present): a staged profile — `checks: [{name: tests, cmd: "bun test"}, {name: style, cmd: "grep -rL TODO src/"}]` equivalent stand-ins — over a planted-bug fixture repo on the cheap tier, with `run_checks` in tools. Expected: the transcript shows the delegate calling `run_checks`, seeing the tests stage fail, fixing, seeing green; the envelope's `checks` array carries both stages; style coaching never appears before tests pass.

**Phase B live check**:

```bash
bun src/cli.ts bench --tiers cheap --config subagents.yaml --deadline-secs 120 --log-dir bench/logs
```

reproduces the 2026-08-06 committed-fixture numbers within noise (routes-recall oracle pass, greet-typo gate pass on gemma-4-e2b); then

```bash
bun src/bench/import-exercism.ts --track typescript --count 5
bun src/cli.ts bench --fixtures "bench/fixtures-exercism/*" --tiers cheap --config subagents.yaml --deadline-secs 240
```

runs five imported exercises end to end; per-turn logs parse and each run's token sum equals its envelope's `local_tokens`.

## Self-Review

**Spec coverage.** Staged checks with stop-at-first-failure → Tasks 1–2; model-triggered validation without bash (zero-arg, budgeted, worktree-required) → Task 3 + the Task-1 amendment; envelope detail with untouched batch predicates → Task 4 (decision 2); same-turn syntax coaching → Task 5; cross-feature integration (the seam class the last branch's Critical hid in) → Task 6; TDD delegation contract, baseline-first → Task 7; one event stream for bench and production → Task 8; deterministic fixtures/oracles → Task 9; in-process runner/scorer → Task 10; CLI + baseline gating → Task 11; standardized write-loop tasks with proven oracles → Task 12; caveated docs → Task 13. Deliberately deferred, restated in Follow-ons: protected_paths, auto-fix stage, LM Studio adapter, MCP, bash, SWE-bench tier.

**Placeholder scan.** No TBDs; every code step carries complete runnable code. Two intentionally derived items are instructions with verification rather than listings: the routes fixture's file contents (recreated from the documented 2026-08-06 fixture, pinned by `grep -n "parse(req.body)"` printing 9/10/12 in Task 9 Step 5) and Task 7's skill text (conditional on baseline outcomes by design — the writing-skills discipline forbids pre-authoring it).

**Type consistency.** `CheckConfig` (Task 1) flows to `runChecks` (Task 2), `makeRunChecks` (Task 3), `Fixture.checks` (Task 9), and the synthetic bench profile (Task 10) unchanged. `ChecksResult.stages` → `CheckVerdict[]` mapping (Task 4) matches the `StageResult` fields by name. `TurnEvent` (Task 8) is what `RunRequest.logPath` serializes and Task 10's `logDir` reuses via `executeRun`. `BenchRow` (Task 10) is what Task 11 writes as JSONL and reads back for baselines (`fixture`/`tier`/`oraclePass` are the only fields the baseline consult reads — forward-compatible with row growth). `resolveProfile`'s `__bench` synthetic profile satisfies the same `ProfileConfig` shape Task 1 validated, including the `run_checks`-requires-worktree rule (write-tool fixtures get worktrees; read fixtures must not list `run_checks` — the two committed fixtures comply).

