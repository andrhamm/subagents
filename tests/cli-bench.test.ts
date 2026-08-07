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
