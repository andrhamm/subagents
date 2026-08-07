import { describe, it, expect, afterEach } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(import.meta.dir, "..", "src", "cli.ts");

async function sh(cwd: string, ...cmd: string[]): Promise<void> {
  const proc = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  if ((await proc.exited) !== 0) {
    throw new Error(`${cmd.join(" ")} failed: ${await new Response(proc.stderr).text()}`);
  }
}

async function initRepo(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "subagents-clichecks-"));
  await sh(dir, "git", "init", "-q");
  await sh(dir, "git", "config", "user.email", "test@example.com");
  await sh(dir, "git", "config", "user.name", "test");
  await sh(dir, "git", "config", "commit.gpgsign", "false");
  writeFileSync(join(dir, "a.ts"), "const a = 1;\n");
  await sh(dir, "git", "add", "-A");
  await sh(dir, "git", "commit", "-qm", "init");
  return dir;
}

function serveScript(script: object[]): { url: string; stop(): void; seen: any[] } {
  const seen: any[] = [];
  let i = 0;
  const server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      seen.push(await req.json());
      const next = script[Math.min(i, script.length - 1)];
      i++;
      return Response.json(next);
    },
  });
  return { url: `http://127.0.0.1:${server.port}/v1`, stop: () => server.stop(true), seen };
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

/** Read a.ts, change 1 → 2, answer. */
const EDIT_SCRIPT = [
  call("c1", "read_file", { path: "a.ts" }),
  call("c2", "edit_file", { path: "a.ts", old_string: "const a = 1;", new_string: "const a = 2;" }),
  answer("changed a to 2"),
];

function writeConfig(repo: string, url: string, profileYaml: string): string {
  const path = join(repo, "subagents.yaml");
  writeFileSync(path, `
providers:
  test: { base_url: "${url}" }
tiers:
  cheap: { provider: test, model: "fake-model" }
profiles:
${profileYaml}
`);
  return path;
}

async function runCli(args: string[]): Promise<{ code: number; out: string; err: string }> {
  const proc = Bun.spawn(["bun", CLI, ...args], { stdout: "pipe", stderr: "pipe" });
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

describe("staged checks through the CLI", () => {
  it("reports the failing stage and stops before later ones", async () => {
    const repo = await initRepo();
    cleanups.push(repo);
    const srv = serveScript(EDIT_SCRIPT);
    try {
      // tests pass after the edit; style demands a line the file lacks.
      const cfg = writeConfig(repo, srv.url, `  fix:
    tools: [read_file, edit_file]
    tier: cheap
    checks:
      - { name: tests, cmd: "grep -q 'const a = 2;' a.ts" }
      - { name: style, cmd: "grep -q COPYRIGHT a.ts" }`);
      const { code, out } = await runCli([
        "run", "--profile", "fix", "--task", "bump a", "--root", repo, "--config", cfg]);
      expect(code).toBe(2);
      const env = JSON.parse(out);
      cleanups.push(env.worktree);
      expect(env.status).toBe("ok");
      expect(env.checks).toEqual([
        { name: "tests", passed: true, timedOut: false },
        { name: "style", passed: false, timedOut: false },
      ]);
      expect(env.test.passed).toBe(false);
      expect(env.test.cmd).toBe("grep -q COPYRIGHT a.ts");
      expect(existsSync(join(env.worktree, "a.ts"))).toBe(true);
      const transcript = await Bun.file(env.transcript).json();
      expect(transcript.test_output).toContain("=== tests: pass ===");
      expect(transcript.test_output).toContain("=== style: fail ===");
    } finally {
      srv.stop();
    }
  });

  it("never runs style when tests fail", async () => {
    const repo = await initRepo();
    cleanups.push(repo);
    const srv = serveScript(EDIT_SCRIPT);
    try {
      const cfg = writeConfig(repo, srv.url, `  fix:
    tools: [read_file, edit_file]
    tier: cheap
    checks:
      - { name: tests, cmd: "grep -q 'const a = 999;' a.ts" }
      - { name: style, cmd: "exit 0" }`);
      const { code, out } = await runCli([
        "run", "--profile", "fix", "--task", "bump a", "--root", repo, "--config", cfg]);
      expect(code).toBe(2);
      const env = JSON.parse(out);
      cleanups.push(env.worktree);
      expect(env.checks).toEqual([{ name: "tests", passed: false, timedOut: false }]);
    } finally {
      srv.stop();
    }
  });

  it("lets the delegate drive run_checks mid-loop and see the verdict", async () => {
    const repo = await initRepo();
    cleanups.push(repo);
    const srv = serveScript([
      call("c1", "read_file", { path: "a.ts" }),
      call("c2", "run_checks", {}),           // red: the edit hasn't happened
      call("c3", "edit_file", { path: "a.ts", old_string: "const a = 1;", new_string: "const a = 2;" }),
      call("c4", "run_checks", {}),           // green
      answer("fixed and verified"),
    ]);
    try {
      const cfg = writeConfig(repo, srv.url, `  fix:
    tools: [read_file, edit_file, run_checks]
    tier: cheap
    test_cmd: "grep -q 'const a = 2;' a.ts"`);
      const { code, out } = await runCli([
        "run", "--profile", "fix", "--task", "bump a", "--root", repo, "--config", cfg]);
      expect(code).toBe(0);
      const env = JSON.parse(out);
      cleanups.push(env.worktree);
      expect(env.test.passed).toBe(true);
      const transcript = await Bun.file(env.transcript).json();
      const toolMsgs = transcript.messages.filter((m: any) => m.role === "tool");
      const checkResults = toolMsgs.filter((m: any) => m.content.includes("tests:"));
      expect(checkResults).toHaveLength(2);
      expect(checkResults[0]!.content).toContain("tests: FAIL");
      expect(checkResults[1]!.content).toContain("All checks pass.");
    } finally {
      srv.stop();
    }
  });
});

describe("per-job check overrides through batch", () => {
  it("gates each job on its own command, not the profile's", async () => {
    const repo = await initRepo();
    cleanups.push(repo);
    const srv = serveScript(EDIT_SCRIPT);
    try {
      const cfg = writeConfig(repo, srv.url, `  fix:
    tools: [read_file, edit_file]
    tier: cheap
    test_cmd: "exit 1"`);
      const jobs = join(repo, "jobs.yaml");
      writeFileSync(jobs, `
jobs:
  - { id: own-gate, profile: fix, task: "bump a", test_cmd: "grep -q 'const a = 2;' a.ts" }
`);
      const { code, out } = await runCli([
        "batch", "--jobs", jobs, "--root", repo, "--config", cfg,
        "--transcript-dir", join(repo, "transcripts")]);
      expect(code).toBe(0); // the override passes even though the profile's cmd never could
      const rollup = JSON.parse(out);
      expect(rollup.status).toBe("ok");
      const env = rollup.jobs[0]!.final.envelope;
      cleanups.push(env.worktree);
      expect(env.test).toEqual({
        ran: true, passed: true, cmd: "grep -q 'const a = 2;' a.ts",
      });
    } finally {
      srv.stop();
    }
  });
});
