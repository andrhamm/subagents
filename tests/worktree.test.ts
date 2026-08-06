import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertGitRepo, collectChanges, createWorktree, removeWorktree } from "../src/worktree";

async function sh(cwd: string, ...cmd: string[]): Promise<void> {
  const proc = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  if ((await proc.exited) !== 0) {
    throw new Error(`${cmd.join(" ")} failed: ${await new Response(proc.stderr).text()}`);
  }
}

async function initRepo(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "subagents-wtrepo-"));
  await sh(dir, "git", "init", "-q");
  await sh(dir, "git", "config", "user.email", "test@example.com");
  await sh(dir, "git", "config", "user.name", "test");
  await sh(dir, "git", "config", "commit.gpgsign", "false");
  writeFileSync(join(dir, "a.ts"), "const a = 1;\n");
  await sh(dir, "git", "add", "-A");
  await sh(dir, "git", "commit", "-qm", "init");
  return dir;
}

let repo: string;
let wt: string;

beforeEach(async () => {
  repo = await initRepo();
  wt = join(mkdtempSync(join(tmpdir(), "subagents-wtdir-")), "tree");
});

afterEach(async () => {
  rmSync(wt, { recursive: true, force: true });
  rmSync(repo, { recursive: true, force: true });
});

describe("assertGitRepo", () => {
  it("passes inside a repository", async () => {
    await assertGitRepo(repo); // must not throw
  });

  it("fails outside one, naming the requirement", async () => {
    const plain = mkdtempSync(join(tmpdir(), "subagents-plain-"));
    try {
      await expect(assertGitRepo(plain)).rejects.toThrow(/git repository/);
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });
});

describe("createWorktree", () => {
  it("materializes HEAD in the target directory", async () => {
    await createWorktree(repo, wt);
    expect(await Bun.file(join(wt, "a.ts")).text()).toBe("const a = 1;\n");
  });

  it("snapshots HEAD, not the caller's dirty tree — the documented caveat", async () => {
    writeFileSync(join(repo, "a.ts"), "const a = 999; // uncommitted\n");
    await createWorktree(repo, wt);
    expect(await Bun.file(join(wt, "a.ts")).text()).toBe("const a = 1;\n");
  });

  it("keeps worktree edits out of the caller's tree", async () => {
    await createWorktree(repo, wt);
    writeFileSync(join(wt, "a.ts"), "const a = 2;\n");
    expect(await Bun.file(join(repo, "a.ts")).text()).toBe("const a = 1;\n");
  });

  it("fails loudly on a non-repository", async () => {
    const plain = mkdtempSync(join(tmpdir(), "subagents-plain-"));
    try {
      await expect(createWorktree(plain, wt)).rejects.toThrow(/worktree add failed/);
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });
});

describe("collectChanges", () => {
  it("reports modified and new files with git's own shortstat", async () => {
    await createWorktree(repo, wt);
    writeFileSync(join(wt, "a.ts"), "const a = 2;\n");
    writeFileSync(join(wt, "b.ts"), "const b = 1;\n");
    const c = await collectChanges(wt);
    expect(c.files.sort()).toEqual(["a.ts", "b.ts"]);
    expect(c.diffstat).toMatch(/2 files changed/);
  });

  it("reports a clean worktree as empty", async () => {
    await createWorktree(repo, wt);
    const c = await collectChanges(wt);
    expect(c.files).toEqual([]);
    expect(c.diffstat).toBe("");
  });
});

describe("removeWorktree", () => {
  it("removes a clean worktree", async () => {
    await createWorktree(repo, wt);
    await removeWorktree(repo, wt);
    expect(existsSync(wt)).toBe(false);
  });
});
