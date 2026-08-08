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

/**
 * Chat script plus LM Studio's /api/v0 management endpoint on one port —
 * executeRun consults the latter for kind: lmstudio runs. `v0` null means
 * the endpoint answers the live unknown-id shape (HTTP 400).
 */
function serveWithV0(
  script: Array<object | { httpStatus: number; body: string }>,
  v0: object | null,
): { url: string; v0Hits: () => number; stop(): void } {
  let i = 0;
  let hits = 0;
  const server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const path = new URL(req.url).pathname;
      if (path.startsWith("/api/v0/models/")) {
        hits++;
        return v0 === null
          ? Response.json({ error: "Model with identifier 'fake-model' not found" }, { status: 400 })
          : Response.json(v0);
      }
      await req.text();
      const next = script[Math.min(i, script.length - 1)]!;
      i++;
      if ("httpStatus" in next) {
        return new Response(next.body as string, {
          status: next.httpStatus as number,
          headers: { "content-type": "application/json" },
        });
      }
      return Response.json(next);
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}/v1`,
    v0Hits: () => hits,
    stop: () => server.stop(true),
  };
}

function readRun(baseUrl: string, kind: "openai" | "lmstudio"): ResolvedRun {
  return {
    baseUrl,
    kind,
    model: "fake-model",
    sampling: {},
    tools: ["read_file"],
    maxTurns: 20,
    maxTokens: 8000,
    timeoutMs: 300_000,
    worktree: false,
    checks: [],
    testTimeoutMs: 120_000,
    provider: "test",
    maxInFlight: 2,
  };
}

// Verbatim /v1/chat/completions HTTP 400 body captured live 2026-08-07 —
// the escaped engine error nested inside the outer "error" string.
const LIVE_EXCEEDED_BODY =
  '{"error":"Engine protocol predict request returned 400: {\\"error\\":{\\"code\\":400,\\"message\\":\\"request (270010 tokens) exceeds the available context size (262144 tokens), try increasing it\\",\\"type\\":\\"exceed_context_size_error\\",\\"n_prompt_tokens\\":270010,\\"n_ctx\\":262144}}"}';

function tmpTranscript(): string {
  const dir = mkdtempSync(join(tmpdir(), "subagents-run-tp-"));
  cleanups.push(dir);
  return join(dir, "t.json");
}

describe("executeRun — context limit from LM Studio's management API", () => {
  it("populates context.limit and pressure for a kind: lmstudio run", async () => {
    const srv = serveWithV0(
      [{
        choices: [{ message: { role: "assistant", content: "done" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 9000, completion_tokens: 10 },
      }],
      { id: "fake-model", state: "loaded", max_context_length: 262144, loaded_context_length: 32768 },
    );
    try {
      const { envelope } = await executeRun({
        run: readRun(srv.url, "lmstudio"), task: "t", root: process.cwd(),
        transcriptPath: tmpTranscript(),
      });
      expect(envelope.context.limit).toBe(32768);
      expect(envelope.context.pressure).toBe(0.27);
      expect(srv.v0Hits()).toBe(1);
    } finally {
      srv.stop();
    }
  });

  it("does not consult /api/v0 for a kind: openai run — limit stays null", async () => {
    const srv = serveWithV0(
      [{
        choices: [{ message: { role: "assistant", content: "done" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 100, completion_tokens: 10 },
      }],
      { id: "fake-model", state: "loaded", loaded_context_length: 32768 },
    );
    try {
      const { envelope } = await executeRun({
        run: readRun(srv.url, "openai"), task: "t", root: process.cwd(),
        transcriptPath: tmpTranscript(),
      });
      expect(envelope.context.limit).toBeNull();
      expect(envelope.context.pressure).toBeNull();
      expect(srv.v0Hits()).toBe(0);
    } finally {
      srv.stop();
    }
  });

  it("names the outgrown context window in the summary on the live exceeded-400, not a generic HTTP 400", async () => {
    const srv = serveWithV0(
      [{ httpStatus: 400, body: LIVE_EXCEEDED_BODY }],
      { id: "fake-model", state: "loaded", max_context_length: 262144, loaded_context_length: 262144 },
    );
    try {
      const { envelope, clean } = await executeRun({
        run: readRun(srv.url, "lmstudio"), task: "t", root: process.cwd(),
        transcriptPath: tmpTranscript(),
      });
      expect(clean).toBe(false);
      expect(envelope.status).toBe("error");
      expect(envelope.summary).toMatch(/outgrew the model's context window/);
      expect(envelope.summary).toContain("270010");
      expect(envelope.summary).toContain("262144");
      expect(envelope.summary).toMatch(/larger-context tier/);
      // The raw error stays available — the summary rewrite must not hide it.
      expect(envelope.detail).toContain("HTTP 400");
      expect(envelope.context.limit).toBe(262144);
    } finally {
      srv.stop();
    }
  });

  it("backfills context.limit from the error's own count when /api/v0 has no answer", async () => {
    const srv = serveWithV0([{ httpStatus: 400, body: LIVE_EXCEEDED_BODY }], null);
    try {
      const { envelope } = await executeRun({
        run: readRun(srv.url, "lmstudio"), task: "t", root: process.cwd(),
        transcriptPath: tmpTranscript(),
      });
      expect(envelope.status).toBe("error");
      expect(envelope.context.limit).toBe(262144);
    } finally {
      srv.stop();
    }
  });

  it("skips the /api/v0 lookup when the deadline is already spent — the envelope must not wait on it", async () => {
    const srv = serveWithV0(
      [{
        choices: [{ message: { role: "assistant", content: "done" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 100, completion_tokens: 10 },
      }],
      { id: "fake-model", state: "loaded", loaded_context_length: 32768 },
    );
    try {
      const { envelope } = await executeRun({
        run: readRun(srv.url, "lmstudio"), task: "t", root: process.cwd(),
        transcriptPath: tmpTranscript(),
        deadlineAt: Date.now() - 1000,
      });
      expect(envelope.status).toBe("deadline");
      expect(envelope.context.limit).toBeNull();
      expect(srv.v0Hits()).toBe(0);
    } finally {
      srv.stop();
    }
  });
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
