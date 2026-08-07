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
