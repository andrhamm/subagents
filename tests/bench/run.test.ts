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
