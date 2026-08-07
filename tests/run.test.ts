import { describe, it, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ResolvedRun } from "../src/config";
import { executeRun } from "../src/run";

// Self-contained git fixture, same shape as tests/cli-write.test.ts.
async function sh(cwd: string, ...cmd: string[]): Promise<void> {
  const proc = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  if ((await proc.exited) !== 0) {
    throw new Error(`${cmd.join(" ")} failed: ${await new Response(proc.stderr).text()}`);
  }
}

async function initRepo(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "subagents-run-"));
  await sh(dir, "git", "init", "-q");
  await sh(dir, "git", "config", "user.email", "test@example.com");
  await sh(dir, "git", "config", "user.name", "test");
  // This machine's global config uses SSH signing, which would hang fixture
  // commits — sanctioned deviation, same as tests/worktree.test.ts.
  await sh(dir, "git", "config", "commit.gpgsign", "false");
  writeFileSync(join(dir, "a.ts"), "const a = 1;\n");
  await sh(dir, "git", "add", "-A");
  await sh(dir, "git", "commit", "-qm", "init");
  return dir;
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

/** Read a.ts, edit it, answer — the smallest script that leaves a change behind. */
const EDIT_SCRIPT = [
  call("c1", "read_file", { path: "a.ts" }),
  call("c2", "edit_file", { path: "a.ts", old_string: "const a = 1;", new_string: "const a = 2;" }),
  answer("changed a to 2"),
];

function serveScript(script: object[]): { url: string; stop(): void } {
  let i = 0;
  const server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      await req.json();
      const next = script[Math.min(i, script.length - 1)];
      i++;
      return Response.json(next);
    },
  });
  return { url: `http://127.0.0.1:${server.port}/v1`, stop: () => server.stop(true) };
}

function writeRun(baseUrl: string): ResolvedRun {
  return {
    baseUrl,
    kind: "openai",
    model: "fake-model",
    sampling: {},
    tools: ["read_file", "edit_file"],
    maxTurns: 20,
    maxTokens: 8000,
    timeoutMs: 300_000,
    worktree: true,
    checks: [{ name: "tests", cmd: "sleep 5" }],
    testTimeoutMs: 120_000,
    provider: "test",
    maxInFlight: 2,
  };
}

const cleanups: string[] = [];
afterEach(() => {
  for (const dir of cleanups.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("executeRun — test gate bounded by the caller's deadline", () => {
  it("clamps a 120s test_timeout_ms to what's left of a near-exhausted deadline", async () => {
    const repo = await initRepo();
    cleanups.push(repo);
    const srv = serveScript(EDIT_SCRIPT);
    const transcriptPath = join(mkdtempSync(join(tmpdir(), "subagents-run-tp-")), "t.json");
    cleanups.push(join(transcriptPath, ".."));
    try {
      const started = Date.now();
      // Must clear loop.ts's own 3000ms wrap-up reserve (DEFAULT_WRAPUP_RESERVE_MS)
      // with margin, or the loop itself stops before turn 1 — before the edit
      // that gives the worktree something to gate. What's left after the loop
      // completes is what the gate clamp is being asked to work with here.
      const { envelope } = await executeRun({
        run: writeRun(srv.url),
        task: "fix a",
        root: repo,
        transcriptPath,
        deadlineAt: Date.now() + 3300,
      });
      const wall = Date.now() - started;
      // The gate command sleeps 5s; if the deadline clamp didn't apply, this
      // run would take at least that long. Generous bound — real behavior is
      // far under it.
      expect(wall).toBeLessThan(4000);
      expect(envelope.test?.passed).toBe(false);
      if (envelope.worktree) cleanups.push(envelope.worktree);
    } finally {
      srv.stop();
    }
  });
});
