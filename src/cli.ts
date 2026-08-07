#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseConfig, resolveProfile } from "./config";
import { executeRun } from "./run";
import { parseJobs, resolveJobs, type ResolvedJob } from "./batch/jobs";
import { schedule, type BatchState, type ScheduleResult } from "./batch/scheduler";
import { needsEscalation, mergeAttempts, type JobReport } from "./batch/escalate";
import { buildRollup } from "./batch/rollup";
import { writeProgress } from "./batch/progress";
import { loadFixture } from "./bench/fixture";
import { runFixture } from "./bench/run";
import type { BenchRow } from "./bench/score";

const USAGE = `subagents run --profile <name> --task <text> [options]
subagents batch --jobs <file> [options]
subagents bench --fixtures <glob> --tiers <a,b> [options]

Options:
  --profile <name>     Profile from config. Required.
  --task <text>        What the delegate should do. Required.
  --root <dir>         Repository root the delegate is confined to. Default: cwd.
  --tier <name>        Override the profile's tier.
  --config <path>      Config file. Default: ./subagents.yaml, then
                       ~/.config/subagents/config.yaml
  --transcript <path>  Where to write the transcript. Default: a temp file.
  --log <path>         Per-turn JSONL events — turn, latency, tools, tokens
  --deadline-secs <n>  Wall-clock budget. Set it below your shell tool's timeout:
                       the loop then stops early with status "deadline" and a
                       valid envelope, instead of being killed with no output.
                       Covers the test gate too: a write profile's test_cmd
                       gets whatever's left of the deadline, clamped below
                       test_timeout_ms.
  --verbose            Print per-turn progress to stderr.

Batch options:
  --jobs <file>           YAML file: jobs: [{id?, profile, task, root?, tier?}]. Required.
  --progress <path>       Progress file, rewritten on every job state change —
                          the poll target for long batches run in the background.
  --escalate-tier <name>  Re-run jobs that failed, stopped early, or worked
                          blind (truncations > 0) once on this tier.
  --transcript-dir <dir>  Per-job transcripts. Default: a temp directory.
  --deadline-secs <n>     Batch budget. Stops STARTING jobs; running jobs
                          finish, never-started ones are listed not_run.
  --config, --root, --verbose  as for run.

Write profiles run in a git worktree detached at HEAD — uncommitted changes
in --root are invisible to the delegate. When the delegate changed files the
worktree is kept and the envelope reports its path, files_changed, diffstat,
and the test gate's verdict.

Exit codes:
  0  completed: status "ok" and the test gate (if configured) passed.
  2  ran, but status is not "ok" or the test gate failed — an envelope is
     still on stdout; read it before treating this as failure.
  1  never started — nothing on stdout, the error is on stderr.

Bench options:
  --fixtures <glob>    Fixture directories to run. A literal directory or a
                       glob of them. Default: bench/fixtures/*
  --tiers <a,b>        Comma-separated tiers to run, each fixture on each.
                       Required. Tier-major: every fixture on tier a, then
                       every fixture on tier b — each model loads once.
  --config <path>      As for run/batch.
  --out <path>         Scored JSONL, one row per (fixture, tier). Default:
                       bench/results.jsonl
  --baseline <path>    Prior JSONL results. A fixture/tier that passed there
                       and fails now is a regression.
  --deadline-secs <n>  Per-fixture wall-clock budget, as for run.
  --log-dir <dir>      Per-turn JSONL events, one file per (fixture, tier).

Bench rows stream to stderr as they land; the run is fail-fast like batch —
every fixture loads and every (fixture, tier) resolves against --config
before anything runs. Exit codes:
  0  ran: every row scored, pass or fail — an oracle failure alone is data,
     not an error. The bench is measurement, not CI, until --baseline says
     otherwise.
  2  ran, and a --baseline row that passed now fails — named on stderr.
  1  never started — nothing on stdout, the error is on stderr.
`;

/** Every option whose value is an arbitrary string, as opposed to a boolean flag. */
const STRING_OPTS = new Set([
  "profile", "task", "root", "tier", "config", "transcript", "deadline-secs", "log",
]);

/**
 * Fold each known string option and its very next token into one
 * `--opt=value` token before handing argv to `parseArgs`.
 *
 * `parseArgs` runs in strict mode, which is what gives a typo'd flag (e.g.
 * `--porfile`) a clear "unknown option" error instead of silently eating
 * it — that's worth keeping. But strict mode also refuses to guess when a
 * string option's value itself starts with `-` (e.g. `--task --help`),
 * throwing "argument is ambiguous" instead of just taking it: argument
 * *position* already answers the question parseArgs is asking, so answer
 * it here rather than losing strict mode everywhere to fix one flag.
 *
 * Only touches a token that is exactly a known long option name with a
 * following token and no `=` already — `--verbose` (boolean) and an
 * option already given as `--x=y` pass through untouched, and a string
 * option with truly nothing after it is left alone too, so parseArgs still
 * reports "argument missing" for that case exactly as before.
 */
function normalizeArgv(argv: string[], stringOpts: ReadonlySet<string>): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i]!;
    const name = tok.startsWith("--") ? tok.slice(2) : undefined;
    if (name && stringOpts.has(name) && i + 1 < argv.length) {
      out.push(`${tok}=${argv[i + 1]}`);
      i++;
    } else {
      out.push(tok);
    }
  }
  return out;
}

const BATCH_STRING_OPTS = new Set([
  "jobs", "config", "root", "progress", "deadline-secs", "escalate-tier", "transcript-dir",
]);

const BENCH_STRING_OPTS = new Set([
  "fixtures", "tiers", "config", "out", "baseline", "deadline-secs", "log-dir",
]);

function findConfig(explicit?: string): string {
  if (explicit) {
    if (!existsSync(explicit)) throw new Error(`config not found: ${explicit}`);
    return explicit;
  }
  for (const candidate of [
    resolve("subagents.yaml"),
    join(homedir(), ".config", "subagents", "config.yaml"),
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(
    "no config found. Looked for ./subagents.yaml and " +
      "~/.config/subagents/config.yaml. Copy subagents.example.yaml to start.",
  );
}

async function main(argv: string[]): Promise<number> {
  const command = argv[0];
  // --help/-h is a success path: print to stdout, exit 0. Every other
  // failure to even start prints to stderr, consistent with the "1 = never
  // started, nothing on stdout" exit-code contract above.
  if (command === "--help" || command === "-h") {
    process.stdout.write(USAGE);
    return 0;
  }
  if (!command) {
    process.stderr.write(USAGE);
    return 1;
  }
  if (command === "run") return runMain(argv.slice(1));
  if (command === "batch") return batchMain(argv.slice(1));
  if (command === "bench") return benchMain(argv.slice(1));
  process.stderr.write(`unknown command '${command}'\n\n${USAGE}`);
  return 1;
}

async function runMain(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: normalizeArgv(argv, STRING_OPTS),
    options: {
      profile: { type: "string" },
      task: { type: "string" },
      root: { type: "string" },
      tier: { type: "string" },
      config: { type: "string" },
      transcript: { type: "string" },
      "deadline-secs": { type: "string" },
      log: { type: "string" },
      verbose: { type: "boolean", default: false },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: false,
  });

  // Second-round fix: this used to be `argv.includes("--help")`, a
  // substring scan over the *whole* argv — which also matched an option's
  // own value (`--task "--help"`), silently printing usage and exiting 0 on
  // a real run. Declaring `help` as a real `parseArgs` option and checking
  // `values.help` (with `normalizeArgv` above resolving the ambiguity that
  // would otherwise cause) makes argument position the parser's problem: a
  // bare `--help`/`-h` token sets this flag, but `--task --help` assigns
  // "--help" as `--task`'s string value and never reaches here as a flag.
  if (values.help) {
    process.stdout.write(USAGE);
    return 0;
  }

  for (const required of ["profile", "task"] as const) {
    if (!values[required]) {
      process.stderr.write(`missing required --${required}\n\n${USAGE}`);
      return 1;
    }
  }

  let deadlineSecs: number | undefined;
  if (values["deadline-secs"] !== undefined) {
    deadlineSecs = Number(values["deadline-secs"]);
    if (!Number.isFinite(deadlineSecs) || deadlineSecs <= 0) {
      process.stderr.write(
        `--deadline-secs must be a positive number, got ` +
          `${JSON.stringify(values["deadline-secs"])}\n`,
      );
      return 1;
    }
  }

  const cfg = parseConfig(await Bun.file(findConfig(values.config)).text());
  const run = resolveProfile(cfg, values.profile!, { tier: values.tier });
  const root = resolve(values.root ?? process.cwd());
  if (!existsSync(root)) throw new Error(`root does not exist: ${root}`);

  const transcriptPath = values.transcript
    ?? join(process.env["TMPDIR"] ?? "/tmp", `subagents-${Date.now()}.json`);
  mkdirSync(resolve(transcriptPath, ".."), { recursive: true });
  // Without this, a typo'd --log directory yields silent zero output: the
  // per-turn writer in executeRun swallows its own mkdir-less ENOENT (it's
  // advisory, like every observer), so nothing ever says the log never landed.
  if (values.log) mkdirSync(resolve(values.log, ".."), { recursive: true });

  const started = Date.now();
  const { envelope, clean } = await executeRun({
    run,
    task: values.task!,
    root,
    transcriptPath,
    ...(deadlineSecs === undefined
      ? {}
      : { deadlineAt: started + deadlineSecs * 1000 }),
    ...(process.env["SUBAGENTS_API_KEY"]
      ? { apiKey: process.env["SUBAGENTS_API_KEY"] }
      : {}),
    ...(values.log ? { logPath: values.log } : {}),
    ...(values.verbose
      ? {
          onTurn: (turn: number, secs: number, names: string[]) =>
            process.stderr.write(
              `  turn ${turn}: ${secs.toFixed(1)}s tools=[${names.join(", ")}]\n`),
        }
      : {}),
  });

  // Compact, not pretty-printed: buildEnvelope's size bound is measured
  // against JSON.stringify(envelope) with no spacing, so stdout must emit
  // exactly that form rather than a differently-sized pretty one.
  process.stdout.write(`${JSON.stringify(envelope)}\n`);
  return clean ? 0 : 2;
}

async function batchMain(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: normalizeArgv(argv, BATCH_STRING_OPTS),
    options: {
      jobs: { type: "string" },
      config: { type: "string" },
      root: { type: "string" },
      progress: { type: "string" },
      "escalate-tier": { type: "string" },
      "transcript-dir": { type: "string" },
      "deadline-secs": { type: "string" },
      verbose: { type: "boolean", default: false },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: false,
  });
  if (values.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (!values.jobs) {
    process.stderr.write(`missing required --jobs\n\n${USAGE}`);
    return 1;
  }
  if (!existsSync(values.jobs)) {
    process.stderr.write(`jobs file not found: ${values.jobs}\n`);
    return 1;
  }

  let deadlineSecs: number | undefined;
  if (values["deadline-secs"] !== undefined) {
    deadlineSecs = Number(values["deadline-secs"]);
    if (!Number.isFinite(deadlineSecs) || deadlineSecs <= 0) {
      process.stderr.write(
        `--deadline-secs must be a positive number, got ` +
          `${JSON.stringify(values["deadline-secs"])}\n`,
      );
      return 1;
    }
  }

  // Fail-fast zone: everything below throws to the top-level catch (exit 1,
  // nothing on stdout) until the first job starts.
  const cfg = parseConfig(await Bun.file(findConfig(values.config)).text());
  const specs = parseJobs(await Bun.file(values.jobs).text());
  const defaultRoot = resolve(values.root ?? process.cwd());
  const jobs = resolveJobs(cfg, specs, defaultRoot);
  const escalateTier = values["escalate-tier"];
  if (escalateTier !== undefined) {
    // An unknown escalation tier must fail before any run, not after the sweep.
    for (const j of jobs) resolveProfile(cfg, j.spec.profile, { tier: escalateTier });
  }

  const transcriptDir = values["transcript-dir"]
    ?? join(process.env["TMPDIR"] ?? "/tmp", `subagents-batch-${Date.now()}`);
  mkdirSync(transcriptDir, { recursive: true });

  const startedAt = Date.now();
  const deadlineAt = deadlineSecs === undefined ? undefined : startedAt + deadlineSecs * 1000;

  // Progress writes are advisory: swallowed failures must not slow or kill
  // the batch. But they are *chained*, not fire-and-forget — unordered
  // writes could let a stale state land after the final one, and the last
  // write must flush before the process exits or the poller's terminal
  // state never appears. During an escalation pass the file tracks that
  // pass's own jobs; the rollup is the cross-pass record.
  let progressChain: Promise<unknown> = Promise.resolve();
  const onUpdate = values.progress !== undefined
    ? (state: BatchState): void => {
        progressChain = progressChain
          .then(() => writeProgress(values.progress!, state))
          .catch(() => {});
      }
    : undefined;

  const runJob = (suffix: string) => (job: ResolvedJob) =>
    executeRun({
      run: job.run,
      task: job.spec.task,
      root: job.root,
      transcriptPath: join(transcriptDir, `${job.id}${suffix}.json`),
      logPath: join(transcriptDir, `${job.id}${suffix}.log.jsonl`),
      ...(deadlineAt === undefined ? {} : { deadlineAt }),
      ...(process.env["SUBAGENTS_API_KEY"]
        ? { apiKey: process.env["SUBAGENTS_API_KEY"] }
        : {}),
      ...(values.verbose
        ? {
            onTurn: (turn: number, secs: number, names: string[]) =>
              process.stderr.write(
                `  [${job.id}${suffix}] turn ${turn}: ${secs.toFixed(1)}s ` +
                  `tools=[${names.join(", ")}]\n`),
          }
        : {}),
    }).then((o) => o.envelope);

  const first = await schedule({
    jobs,
    runJob: runJob(""),
    ...(deadlineAt === undefined ? {} : { deadlineAt }),
    ...(onUpdate ? { onUpdate } : {}),
  });

  let second: ScheduleResult = { results: [], notRun: [] };
  let reports: JobReport[];
  if (escalateTier !== undefined) {
    const failingIds = new Set(first.results.filter(needsEscalation).map((r) => r.id));
    if (failingIds.size > 0) {
      const retryJobs = resolveJobs(
        cfg,
        specs.filter((s) => failingIds.has(s.id)).map((s) => ({ ...s, tier: escalateTier })),
        defaultRoot,
      );
      // A deadline hit during escalation leaves first attempts standing —
      // visible as a single-attempt report, never a dropped job.
      second = await schedule({
        jobs: retryJobs,
        runJob: runJob(".escalated"),
        ...(deadlineAt === undefined ? {} : { deadlineAt }),
        ...(onUpdate ? { onUpdate } : {}),
      });
    }
    reports = mergeAttempts(first.results, second.results, escalateTier);
  } else {
    reports = mergeAttempts(first.results, [], "");
  }

  const rollup = buildRollup({
    reports,
    timings: [...first.results, ...second.results],
    notRun: first.notRun,
    configured: Math.max(...jobs.map((j) => j.run.maxInFlight)),
    wallSecs: (Date.now() - startedAt) / 1000,
    transcriptDir,
  });

  // Flush the last progress state before exiting — process.exit does not
  // wait for a pending Bun.write.
  await progressChain;

  // Compact single line, like the run envelope — machine-read first.
  process.stdout.write(`${JSON.stringify(rollup)}\n`);
  return rollup.status === "ok" ? 0 : 2;
}

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
  // A value like "," or ",," survives parseArgs (it's a non-empty string)
  // but splits into zero usable tiers — without this check the loop below
  // simply never iterates: exit 0, an empty --out, no hint why.
  const tiers = values.tiers.split(",").map((t) => t.trim()).filter(Boolean);
  if (tiers.length === 0) {
    process.stderr.write(
      `--tiers resolved to no tiers (got ${JSON.stringify(values.tiers)})\n`);
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
        .map((r) => [`${r.fixture}::${r.tier}`, r.oraclePass]),
    );
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
      const key = `${row.fixture}::${row.tier}`;
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

try {
  process.exit(await main(process.argv.slice(2)));
} catch (e) {
  process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
}
