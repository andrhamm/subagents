import { describe, it, expect, afterEach } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(import.meta.dir, "..", "src", "cli.ts");

// Self-contained git fixture, same shape as tests/cli-write.test.ts — each
// test file stands alone by suite convention.
async function sh(cwd: string, ...cmd: string[]): Promise<void> {
  const proc = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  if ((await proc.exited) !== 0) {
    throw new Error(`${cmd.join(" ")} failed: ${await new Response(proc.stderr).text()}`);
  }
}

async function initGitRepo(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "subagents-batchw-"));
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

/** One scripted fake model per test; replays `script`. */
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

const answerMsg = (text: string) => ({
  choices: [{ message: { role: "assistant", content: text }, finish_reason: "stop" }],
  usage: { prompt_tokens: 100, completion_tokens: 10 },
});

/** Read a.ts, edit it, answer — the canonical write-profile script. */
const EDIT_SCRIPT = [
  call("c1", "read_file", { path: "a.ts" }),
  call("c2", "edit_file", { path: "a.ts", old_string: "const a = 1;", new_string: "const a = 2;" }),
  answerMsg("changed a to 2"),
];

/** A fake model that always answers in prose (one clean ok turn). */
function serveAnswer(text: string): { url: string; stop(): void } {
  const server = Bun.serve({
    port: 0,
    fetch: () => Response.json({
      choices: [{ message: { role: "assistant", content: text }, finish_reason: "stop" }],
      usage: { prompt_tokens: 50, completion_tokens: 5 },
    }),
  });
  return { url: `http://127.0.0.1:${server.port}/v1`, stop: () => server.stop(true) };
}

/** A fake model that returns no tool calls and no content — the capability-error shape. */
function serveBroken(): { url: string; stop(): void } {
  const server = Bun.serve({
    port: 0,
    fetch: () => Response.json({
      choices: [{ message: { role: "assistant", content: "" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 50, completion_tokens: 0 },
    }),
  });
  return { url: `http://127.0.0.1:${server.port}/v1`, stop: () => server.stop(true) };
}

function fixture(cheapUrl: string, strongUrl: string): { root: string; config: string; jobs: string } {
  const root = mkdtempSync(join(tmpdir(), "subagents-batch-"));
  writeFileSync(join(root, "a.ts"), "const a = 1;\n");
  const config = join(root, "subagents.yaml");
  writeFileSync(config, `
providers:
  p1: { base_url: "${cheapUrl}", max_in_flight: 2 }
  p2: { base_url: "${strongUrl}" }
tiers:
  cheap:  { provider: p1, model: "small" }
  strong: { provider: p2, model: "big" }
profiles:
  digest: { tools: [read_file], tier: cheap }
`);
  const jobs = join(root, "jobs.yaml");
  writeFileSync(jobs, `
jobs:
  - { id: one,   profile: digest, task: "first" }
  - { id: two,   profile: digest, task: "second" }
  - { id: three, profile: digest, task: "third", tier: strong }
`);
  return { root, config, jobs };
}

async function runBatch(args: string[]): Promise<{ code: number; out: string; err: string }> {
  const proc = Bun.spawn(["bun", CLI, "batch", ...args], { stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code: await proc.exited, out, err };
}

const cleanups: string[] = [];
afterEach(() => {
  for (const dir of cleanups.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("subagents batch", () => {
  it("runs every job and prints one compact rollup", async () => {
    const cheap = serveAnswer("done-cheap");
    const strong = serveAnswer("done-strong");
    const f = fixture(cheap.url, strong.url);
    cleanups.push(f.root);
    try {
      const tdir = join(f.root, "transcripts");
      const { code, out } = await runBatch([
        "--jobs", f.jobs, "--config", f.config, "--root", f.root, "--transcript-dir", tdir,
      ]);
      expect(code).toBe(0);
      expect(out.trim().includes("\n")).toBe(false); // one line, like the run envelope
      const rollup = JSON.parse(out);
      expect(rollup.status).toBe("ok");
      expect(rollup.jobs).toHaveLength(3);
      expect(rollup.not_run).toEqual([]);
      expect(rollup.jobs.every((j: any) => j.final.envelope.status === "ok")).toBe(true);
      expect(typeof rollup.concurrency.achieved_throughput_per_min).toBe("number");
      expect(rollup.concurrency.configured).toBe(2);
      for (const id of ["one", "two", "three"]) {
        expect(existsSync(join(tdir, `${id}.json`))).toBe(true);
      }
    } finally {
      cheap.stop();
      strong.stop();
    }
  });

  it("maintains the progress file through to a final complete state", async () => {
    const cheap = serveAnswer("x");
    const strong = serveAnswer("y");
    const f = fixture(cheap.url, strong.url);
    cleanups.push(f.root);
    try {
      const progress = join(f.root, "progress.json");
      const { code } = await runBatch([
        "--jobs", f.jobs, "--config", f.config, "--root", f.root, "--progress", progress,
      ]);
      expect(code).toBe(0);
      const state = JSON.parse(await Bun.file(progress).text());
      expect(state.total).toBe(3);
      expect(state.done.sort()).toEqual(["one", "three", "two"]);
      expect(state.running).toEqual([]);
      expect(state.pending).toEqual([]);
    } finally {
      cheap.stop();
      strong.stop();
    }
  });

  it("names every job not_run when the deadline is already spent", async () => {
    const cheap = serveAnswer("x");
    const strong = serveAnswer("y");
    const f = fixture(cheap.url, strong.url);
    cleanups.push(f.root);
    try {
      const { code, out } = await runBatch([
        "--jobs", f.jobs, "--config", f.config, "--root", f.root, "--deadline-secs", "0.001",
      ]);
      expect(code).toBe(2);
      const rollup = JSON.parse(out);
      expect(rollup.status).toBe("partial");
      expect(rollup.not_run.sort()).toEqual(["one", "three", "two"]);
      expect(rollup.jobs).toEqual([]);
    } finally {
      cheap.stop();
      strong.stop();
    }
  });

  it("escalates failed jobs to the named tier and reports both attempts", async () => {
    const cheap = serveBroken(); // no tool calls, no content → status "error"
    const strong = serveAnswer("recovered");
    const f = fixture(cheap.url, strong.url);
    cleanups.push(f.root);
    try {
      const tdir = join(f.root, "transcripts");
      // Only cheap-tier jobs: both fail on p1, both must recover on strong/p2.
      writeFileSync(join(f.root, "jobs.yaml"), `
jobs:
  - { id: one, profile: digest, task: "first" }
  - { id: two, profile: digest, task: "second" }
`);
      const { code, out } = await runBatch([
        "--jobs", join(f.root, "jobs.yaml"), "--config", f.config, "--root", f.root,
        "--transcript-dir", tdir, "--escalate-tier", "strong",
      ]);
      expect(code).toBe(0);
      const rollup = JSON.parse(out);
      expect(rollup.status).toBe("ok");
      for (const job of rollup.jobs) {
        expect(job.attempts).toHaveLength(2);
        expect(job.attempts[0].envelope.status).toBe("error");
        expect(job.attempts[1].tier).toBe("strong");
        expect(job.final.envelope.status).toBe("ok");
        expect(job.final.envelope.summary).toBe("recovered");
      }
      expect(existsSync(join(tdir, "one.json"))).toBe(true);
      expect(existsSync(join(tdir, "one.escalated.json"))).toBe(true);
    } finally {
      cheap.stop();
      strong.stop();
    }
  });

  it("fails fast on a bad jobs file: exit 1, the job named, nothing on stdout", async () => {
    const cheap = serveAnswer("x");
    const strong = serveAnswer("y");
    const f = fixture(cheap.url, strong.url);
    cleanups.push(f.root);
    try {
      writeFileSync(join(f.root, "jobs.yaml"),
        `jobs:\n  - { id: oops, profile: ghost, task: "t" }\n`);
      const { code, out, err } = await runBatch([
        "--jobs", join(f.root, "jobs.yaml"), "--config", f.config, "--root", f.root,
      ]);
      expect(code).toBe(1);
      expect(out).toBe("");
      expect(err).toContain("job 'oops'");
      expect(err).toContain("ghost");
    } finally {
      cheap.stop();
      strong.stop();
    }
  });

  // Phase A (write profiles + test gate) x Phase B (batch rollup + escalation):
  // a write job whose loop succeeds but whose gate fails must not roll up
  // clean, and the batch must exit non-zero for it.
  it("does not roll up clean when a write job's test gate fails", async () => {
    const repo = await initGitRepo();
    cleanups.push(repo);
    const srv = serveScript(EDIT_SCRIPT);
    try {
      const config = join(repo, "subagents.yaml");
      writeFileSync(config, `
providers:
  test: { base_url: "${srv.url}" }
tiers:
  cheap: { provider: test, model: "fake-model" }
profiles:
  fix: { tools: [read_file, edit_file], tier: cheap, test_cmd: "grep -q nope a.ts" }
`);
      const jobsFile = join(repo, "jobs.yaml");
      writeFileSync(jobsFile, `
jobs:
  - { id: one, profile: fix, task: "fix a" }
`);
      const tdir = join(repo, "transcripts");
      const { code, out } = await runBatch([
        "--jobs", jobsFile, "--config", config, "--root", repo, "--transcript-dir", tdir,
      ]);
      expect(code).toBe(2);
      const rollup = JSON.parse(out);
      expect(rollup.status).not.toBe("ok");
      const job = rollup.jobs.find((j: any) => j.id === "one");
      expect(job.final.envelope.status).toBe("ok"); // the loop itself completed
      expect(job.final.envelope.test.passed).toBe(false); // but the gate didn't
      cleanups.push(job.final.envelope.worktree);
    } finally {
      srv.stop();
    }
  });
});
