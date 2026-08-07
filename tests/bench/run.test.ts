import { describe, it, expect, afterEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

/** Fake model that plays back a fixed script of responses, one per call. */
function serveScript(script: object[]): { url: string; stop(): void } {
  let i = 0;
  const server = Bun.serve({
    port: 0,
    fetch: () => {
      const next = script[Math.min(i, script.length - 1)];
      i++;
      return Response.json(next);
    },
  });
  return { url: `http://127.0.0.1:${server.port}/v1`, stop: () => server.stop(true) };
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

  // The headline write path: read, edit, answer, gate green, oracle green —
  // and the worktree executeRun kept for the diff must not survive the
  // bench run that scored it. Left behind, it lives in TMPDIR outside the
  // fixture's throwaway root, so nothing else ever removes it.
  it("scores a gated write fixture green and removes the worktree it kept", async () => {
    const srv = serveScript([
      call("c1", "read_file", { path: "src/greet.ts" }),
      call("c2", "edit_file", {
        path: "src/greet.ts",
        old_string: "return `Helo, ${name}!`;",
        new_string: "return `Hello, ${name}!`;",
      }),
      answer("Fixed the typo in greet()."),
    ]);
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
      const { row, envelope } = await runFixture(fx, "cheap", cfg, { deadlineSecs: 60 });
      expect(row.gatePassed).toBe(true);
      expect(row.oraclePass).toBe(true);
      expect(row.failures).toEqual([]);
      expect(envelope.worktree).toBeTruthy();
      expect(existsSync(envelope.worktree!)).toBe(false);
    } finally {
      srv.stop();
    }
  });
});
