#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseConfig, resolveProfile } from "./config";
import { OpenAIBackend } from "./backends/base";
import { resolveTools } from "./tools/registry";
import { runLoop } from "./loop";
import { buildEnvelope } from "./envelope";
import { writeTranscript } from "./transcript";

const USAGE = `subagents run --profile <name> --task <text> [options]

Options:
  --profile <name>     Profile from config. Required.
  --task <text>        What the delegate should do. Required.
  --root <dir>         Repository root the delegate is confined to. Default: cwd.
  --tier <name>        Override the profile's tier.
  --config <path>      Config file. Default: ./subagents.yaml, then
                       ~/.config/subagents/config.yaml
  --transcript <path>  Where to write the transcript. Default: a temp file.
  --deadline-secs <n>  Wall-clock budget. Set it below your shell tool's timeout:
                       the loop then stops early with status "deadline" and a
                       valid envelope, instead of being killed with no output.
  --verbose            Print per-turn progress to stderr.

Exit codes:
  0  completed: status "ok".
  2  ran, but status is not "ok" (max_turns, budget, deadline, or error) —
     an envelope is still on stdout; read it before treating this as failure.
  1  never started — nothing on stdout, the error is on stderr.
`;

/** Every option whose value is an arbitrary string, as opposed to a boolean flag. */
const STRING_OPTS = new Set([
  "profile", "task", "root", "tier", "config", "transcript", "deadline-secs",
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
function normalizeArgv(argv: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i]!;
    const name = tok.startsWith("--") ? tok.slice(2) : undefined;
    if (name && STRING_OPTS.has(name) && i + 1 < argv.length) {
      out.push(`${tok}=${argv[i + 1]}`);
      i++;
    } else {
      out.push(tok);
    }
  }
  return out;
}

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
  if (command !== "run") {
    process.stderr.write(`unknown command '${command}'\n\n${USAGE}`);
    return 1;
  }

  const { values } = parseArgs({
    args: normalizeArgv(argv.slice(1)),
    options: {
      profile: { type: "string" },
      task: { type: "string" },
      root: { type: "string" },
      tier: { type: "string" },
      config: { type: "string" },
      transcript: { type: "string" },
      "deadline-secs": { type: "string" },
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

  // Resolved on its own statement, not inlined into the runLoop call below:
  // an unknown tool name in the profile must fail before any backend call
  // is made, and that ordering should hold because it's stated, not because
  // of where it happens to sit in an object literal's argument evaluation.
  const tools = resolveTools(run.tools);

  const started = Date.now();
  const result = await runLoop({
    backend: new OpenAIBackend(run.baseUrl, process.env["SUBAGENTS_API_KEY"]),
    model: run.model,
    tools,
    task: values.task!,
    maxTurns: run.maxTurns,
    maxTokens: run.maxTokens,
    sampling: run.sampling,
    timeoutMs: run.timeoutMs,
    root,
    ...(deadlineSecs === undefined
      ? {}
      : { deadlineAt: started + deadlineSecs * 1000 }),
    ...(values.verbose
      ? {
          onTurn: (turn: number, secs: number, names: string[]) =>
            process.stderr.write(
              `  turn ${turn}: ${secs.toFixed(1)}s tools=[${names.join(", ")}]\n`),
        }
      : {}),
  });

  // The transcript is a side channel, not the envelope's own promise to the
  // caller: an I/O failure writing it (a full disk, an unwritable path)
  // must not take down the run that already produced a valid result. If it
  // fails, say so honestly in the field that would otherwise silently point
  // at a path with nothing in it.
  let transcriptField = transcriptPath;
  try {
    await writeTranscript(transcriptPath, {
      model: run.model,
      task: values.task!,
      status: result.status,
      messages: result.messages,
      usage: result.usage,
    });
  } catch (e) {
    transcriptField =
      `${transcriptPath} (FAILED to write: ${e instanceof Error ? e.message : String(e)})`;
  }

  const envelope = buildEnvelope(result, {
    wallSecs: (Date.now() - started) / 1000,
    transcript: transcriptField,
    contextLimit: null,
  });
  // Compact, not pretty-printed: buildEnvelope's size bound is measured
  // against JSON.stringify(envelope) with no spacing, so stdout must emit
  // exactly that form rather than a differently-sized pretty one.
  process.stdout.write(`${JSON.stringify(envelope)}\n`);
  return result.status === "ok" ? 0 : 2;
}

try {
  process.exit(await main(process.argv.slice(2)));
} catch (e) {
  process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
}
