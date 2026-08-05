import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let root: string;
let server: ReturnType<typeof Bun.serve>;
let turn = 0;

const CLI = join(import.meta.dir, "..", "src", "cli.ts");

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "subagents-cli-"));
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "a.ts"), "const answer = 42;\n");

  // Fake model: reads the file on turn 1, answers on turn 2.
  server = Bun.serve({
    port: 0,
    fetch: async () => {
      turn++;
      if (turn === 1) {
        return Response.json({
          choices: [{
            message: {
              role: "assistant", content: null,
              tool_calls: [{
                id: "c1",
                function: { name: "read_file", arguments: '{"path":"src/a.ts"}' },
              }],
            },
            finish_reason: "tool_calls",
          }],
          usage: { prompt_tokens: 300, completion_tokens: 20 },
        });
      }
      return Response.json({
        choices: [{
          message: { role: "assistant", content: "answer is on line 1" },
          finish_reason: "stop",
        }],
        usage: { prompt_tokens: 900, completion_tokens: 15 },
      });
    },
  });

  writeFileSync(join(root, "subagents.yaml"), `
providers:
  test: { base_url: "http://127.0.0.1:${server.port}/v1" }
tiers:
  cheap: { provider: test, model: "fake-model" }
profiles:
  digest: { tools: [read_file, glob, grep], tier: cheap }
`);
});

afterAll(() => {
  server.stop(true);
  rmSync(root, { recursive: true, force: true });
});

describe("subagents run", () => {
  it("runs a task and prints a small envelope on stdout", async () => {
    const proc = Bun.spawn(
      ["bun", CLI, "run", "--profile", "digest", "--task", "where is the answer?",
       "--root", root, "--config", join(root, "subagents.yaml")],
      { stdout: "pipe", stderr: "pipe" },
    );
    const out = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(0);

    const env = JSON.parse(out);
    expect(env.status).toBe("ok");
    expect(env.summary).toBe("answer is on line 1");
    expect(env.turns).toBe(2);
    expect(env.local_tokens).toBe(300 + 20 + 900 + 15);
    expect(env.truncations).toBe(0);

    const transcript = await Bun.file(env.transcript).json();
    expect(transcript.messages.map((m: { role: string }) => m.role))
      .toEqual(["system", "user", "assistant", "tool", "assistant"]);
  });

  it("exits non-zero with a readable error on an unknown profile", async () => {
    const proc = Bun.spawn(
      ["bun", CLI, "run", "--profile", "ghost", "--task", "x",
       "--root", root, "--config", join(root, "subagents.yaml")],
      { stdout: "pipe", stderr: "pipe" },
    );
    const err = await new Response(proc.stderr).text();
    expect(await proc.exited).toBe(1);
    expect(err).toContain("unknown profile 'ghost'");
    expect(err).toContain("digest");
  });

  it("exits non-zero when required arguments are missing", async () => {
    const proc = Bun.spawn(["bun", CLI, "run", "--profile", "digest"],
      { stdout: "pipe", stderr: "pipe" });
    const err = await new Response(proc.stderr).text();
    expect(await proc.exited).toBe(1);
    expect(err).toContain("--task");
  });

  it("rejects a non-numeric --deadline-secs", async () => {
    const proc = Bun.spawn(
      ["bun", CLI, "run", "--profile", "digest", "--task", "x", "--root", root,
       "--config", join(root, "subagents.yaml"), "--deadline-secs", "soon"],
      { stdout: "pipe", stderr: "pipe" },
    );
    const err = await new Response(proc.stderr).text();
    expect(await proc.exited).toBe(1);
    expect(err).toContain("--deadline-secs must be a positive number");
  });

  it("returns a valid envelope rather than nothing when the deadline is already spent", async () => {
    const proc = Bun.spawn(
      ["bun", CLI, "run", "--profile", "digest", "--task", "x", "--root", root,
       "--config", join(root, "subagents.yaml"), "--deadline-secs", "0.001"],
      { stdout: "pipe", stderr: "pipe" },
    );
    const out = await new Response(proc.stdout).text();
    // Non-zero exit, but stdout MUST still carry a parseable envelope — the
    // whole point of the deadline is that the caller is never left with nothing.
    expect(await proc.exited).not.toBe(0);
    const env = JSON.parse(out);
    expect(env.status).toBe("deadline");
    expect(env.transcript).toBeTruthy();
  });

  it("still emits a valid envelope on stdout when the transcript write fails", async () => {
    // A directory can never be written as a file — Bun.write throws EISDIR.
    // The envelope is the only thing writeTranscript's caller (main) has
    // promised to the caller; an I/O failure on the side channel must not
    // take that down too.
    const proc = Bun.spawn(
      ["bun", CLI, "run", "--profile", "digest", "--task", "where is the answer?",
       "--root", root, "--config", join(root, "subagents.yaml"), "--transcript", root],
      { stdout: "pipe", stderr: "pipe" },
    );
    const out = await new Response(proc.stdout).text();
    const env = JSON.parse(out);
    expect(env.status).toBe("ok");
    // Honest, not silent: the envelope's transcript field must say the
    // write failed rather than pointing at a path with nothing in it.
    expect(env.transcript).toContain(root);
    expect(env.transcript.toLowerCase()).toMatch(/fail|error/);
  });

  it("prints USAGE and exits 0 for 'run --help' instead of a raw parseArgs error", async () => {
    const proc = Bun.spawn(["bun", CLI, "run", "--help"], { stdout: "pipe", stderr: "pipe" });
    const out = await new Response(proc.stdout).text();
    const err = await new Response(proc.stderr).text();
    expect(await proc.exited).toBe(0);
    expect(out).toContain("subagents run --profile");
    expect(err).toBe("");
  });

  it("writes USAGE to stderr and exits non-zero for a bare invocation, like every other failure path", async () => {
    const proc = Bun.spawn(["bun", CLI], { stdout: "pipe", stderr: "pipe" });
    const out = await new Response(proc.stdout).text();
    const err = await new Response(proc.stderr).text();
    expect(await proc.exited).toBe(1);
    expect(err).toContain("subagents run --profile");
    expect(out).toBe("");
  });

  it("emits a compact single-line envelope, matching the form the size bound is enforced against", async () => {
    const proc = Bun.spawn(
      ["bun", CLI, "run", "--profile", "digest", "--task", "where is the answer?",
       "--root", root, "--config", join(root, "subagents.yaml")],
      { stdout: "pipe", stderr: "pipe" },
    );
    const out = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(0);
    // Exactly one trailing newline, no pretty-printed indentation — the
    // envelope's own size bound (buildEnvelope, 600 chars) is measured
    // against JSON.stringify(e) with no spacing, so stdout must emit that
    // same compact form rather than a differently-sized pretty one.
    expect(out.endsWith("\n")).toBe(true);
    expect(out.trim().includes("\n")).toBe(false);
  });
});
