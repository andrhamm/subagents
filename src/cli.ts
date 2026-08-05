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
`;

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
  if (!command || command === "--help" || command === "-h") {
    process.stdout.write(USAGE);
    return command ? 0 : 1;
  }
  if (command !== "run") {
    process.stderr.write(`unknown command '${command}'\n\n${USAGE}`);
    return 1;
  }

  const { values } = parseArgs({
    args: argv.slice(1),
    options: {
      profile: { type: "string" },
      task: { type: "string" },
      root: { type: "string" },
      tier: { type: "string" },
      config: { type: "string" },
      transcript: { type: "string" },
      "deadline-secs": { type: "string" },
      verbose: { type: "boolean", default: false },
    },
    allowPositionals: false,
  });

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

  const started = Date.now();
  const result = await runLoop({
    backend: new OpenAIBackend(run.baseUrl, process.env["SUBAGENTS_API_KEY"]),
    model: run.model,
    tools: resolveTools(run.tools),
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

  await writeTranscript(transcriptPath, {
    model: run.model,
    task: values.task!,
    status: result.status,
    messages: result.messages,
    usage: result.usage,
  });

  const envelope = buildEnvelope(result, {
    wallSecs: (Date.now() - started) / 1000,
    transcript: transcriptPath,
    contextLimit: null,
  });
  process.stdout.write(`${JSON.stringify(envelope, null, 1)}\n`);
  return result.status === "ok" ? 0 : 2;
}

try {
  process.exit(await main(process.argv.slice(2)));
} catch (e) {
  process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
}
