import { describe, it, expect, afterEach } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(import.meta.dir, "..", "src", "cli.ts");

// Self-contained git fixture, same shape as tests/worktree.test.ts — each
// test file stands alone by suite convention.
async function sh(cwd: string, ...cmd: string[]): Promise<void> {
  const proc = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  if ((await proc.exited) !== 0) {
    throw new Error(`${cmd.join(" ")} failed: ${await new Response(proc.stderr).text()}`);
  }
}

async function initRepo(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "subagents-cliw-"));
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

/** One scripted fake model per test; replays `script` and records request bodies. */
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

/** The canonical write run: read a.ts, fix it, answer. */
const EDIT_SCRIPT = [
  call("c1", "read_file", { path: "a.ts" }),
  call("c2", "edit_file", { path: "a.ts", old_string: "const a = 1;", new_string: "const a = 2;" }),
  answer("changed a to 2"),
];

function writeConfig(repo: string, url: string, extraProfile = ""): string {
  const path = join(repo, "subagents.yaml");
  writeFileSync(path, `
providers:
  test: { base_url: "${url}" }
tiers:
  cheap: { provider: test, model: "fake-model" }
profiles:
  fix: { tools: [read_file, edit_file], tier: cheap${extraProfile} }
  digest: { tools: [read_file], tier: cheap }
`);
  return path;
}

async function runCli(repo: string, config: string, profile = "fix"):
  Promise<{ code: number; out: string; err: string }> {
  const proc = Bun.spawn(
    ["bun", CLI, "run", "--profile", profile, "--task", "fix a", "--root", repo, "--config", config],
    { stdout: "pipe", stderr: "pipe" },
  );
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

describe("subagents run — write profiles", () => {
  it("lands the edit in a kept worktree, never the caller's tree", async () => {
    const repo = await initRepo();
    cleanups.push(repo);
    const srv = serveScript(EDIT_SCRIPT);
    try {
      const { code, out } = await runCli(repo, writeConfig(repo, srv.url));
      expect(code).toBe(0); // status ok, no test gate configured
      const env = JSON.parse(out);
      expect(env.status).toBe("ok");
      expect(env.files_changed).toEqual(["a.ts"]);
      expect(env.diffstat).toMatch(/1 file changed/);
      expect(env.worktree).toBeTruthy();
      cleanups.push(env.worktree);
      expect(await Bun.file(join(env.worktree, "a.ts")).text()).toBe("const a = 2;\n");
      expect(await Bun.file(join(repo, "a.ts")).text()).toBe("const a = 1;\n");
    } finally {
      srv.stop();
    }
  });

  it("passes the test gate and exits 0", async () => {
    const repo = await initRepo();
    cleanups.push(repo);
    const srv = serveScript(EDIT_SCRIPT);
    try {
      const cfg = writeConfig(repo, srv.url, `, test_cmd: "grep -q 'const a = 2;' a.ts" `);
      const { code, out } = await runCli(repo, cfg);
      expect(code).toBe(0);
      const env = JSON.parse(out);
      expect(env.test).toEqual({ ran: true, passed: true, cmd: "grep -q 'const a = 2;' a.ts" });
      cleanups.push(env.worktree);
    } finally {
      srv.stop();
    }
  });

  it("reports a failed gate, keeps the worktree, and exits 2", async () => {
    const repo = await initRepo();
    cleanups.push(repo);
    const srv = serveScript(EDIT_SCRIPT);
    try {
      const cfg = writeConfig(repo, srv.url, `, test_cmd: "grep -q nope a.ts" `);
      const { code, out } = await runCli(repo, cfg);
      expect(code).toBe(2); // ran, but the gate failed — envelope still on stdout
      const env = JSON.parse(out);
      expect(env.status).toBe("ok"); // the loop itself completed
      expect(env.test.passed).toBe(false);
      // Keep + report: the failed diff is still the orchestrator's to inspect.
      expect(existsSync(join(env.worktree, "a.ts"))).toBe(true);
      expect(await Bun.file(join(env.worktree, "a.ts")).text()).toBe("const a = 2;\n");
      cleanups.push(env.worktree);
      const transcript = await Bun.file(env.transcript).json();
      expect(typeof transcript.test_output).toBe("string");
    } finally {
      srv.stop();
    }
  });

  it("removes the worktree and omits write fields when nothing changed", async () => {
    const repo = await initRepo();
    cleanups.push(repo);
    const srv = serveScript([answer("nothing to do")]);
    try {
      const { code, out } = await runCli(repo, writeConfig(repo, srv.url));
      expect(code).toBe(0);
      const env = JSON.parse(out);
      expect(env.files_changed).toBeUndefined();
      expect(env.worktree).toBeUndefined();
      expect(env.test).toBeUndefined();
    } finally {
      srv.stop();
    }
  });

  it("refuses a write profile outside a git repository, before any backend call", async () => {
    const plain = mkdtempSync(join(tmpdir(), "subagents-plainw-"));
    cleanups.push(plain);
    const srv = serveScript(EDIT_SCRIPT);
    try {
      const { code, err } = await runCli(plain, writeConfig(plain, srv.url));
      expect(code).toBe(1); // never started: nothing on stdout, reason on stderr
      expect(err).toContain("git repository");
      expect(srv.seen).toHaveLength(0);
    } finally {
      srv.stop();
    }
  });

  it("appends the write suffix to the system prompt for write profiles only", async () => {
    const repo = await initRepo();
    cleanups.push(repo);
    const srv = serveScript(EDIT_SCRIPT);
    try {
      const cfg = writeConfig(repo, srv.url);
      const first = await runCli(repo, cfg);
      cleanups.push(JSON.parse(first.out).worktree);
      expect(srv.seen[0].messages[0].content).toContain("smallest change");
      const readonlySeen = srv.seen.length;
      await runCli(repo, cfg, "digest");
      expect(srv.seen[readonlySeen].messages[0].content).not.toContain("smallest change");
    } finally {
      srv.stop();
    }
  });
});
