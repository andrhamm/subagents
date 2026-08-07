import { markIfCut } from "./text";

/** Run git in `cwd`, capturing output. Non-zero exit is a value, not a throw. */
async function git(
  cwd: string, ...args: string[]
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { ok: (await proc.exited) === 0, stdout, stderr };
}

/** Loud, actionable failure when `root` cannot host a worktree. */
export async function assertGitRepo(root: string): Promise<void> {
  const r = await git(root, "rev-parse", "--is-inside-work-tree");
  if (!r.ok || r.stdout.trim() !== "true") {
    throw new Error(
      `write profiles need worktree isolation, which needs a git repository — ` +
        `'${root}' is not inside one: ${markIfCut(r.stderr.trim() || "rev-parse said no", 200)}`,
    );
  }
}

/**
 * A detached worktree at HEAD. The delegate sees the last *commit*, not the
 * caller's uncommitted changes — callers must commit or stash first. The
 * trade is deliberate: detached from HEAD, the worktree can never corrupt
 * the caller's index or working tree, whatever the delegate does.
 */
export async function createWorktree(repoRoot: string, dir: string): Promise<void> {
  const r = await git(repoRoot, "worktree", "add", "--detach", dir);
  if (!r.ok) {
    throw new Error(`git worktree add failed: ${markIfCut(r.stderr.trim(), 300)}`);
  }
}

export interface WorktreeChanges {
  /** Root-relative paths, new files included. */
  files: string[];
  /** git's own one-line summary, e.g. "2 files changed, 5 insertions(+)". "" when clean. */
  diffstat: string;
}

/**
 * Stage everything — the tree is throwaway, so mutating its index is free —
 * then diff the index against HEAD. `--cached` after `add -A` is what makes
 * brand-new files show up at all; a plain `git diff` would omit them.
 */
export async function collectChanges(dir: string): Promise<WorktreeChanges> {
  const add = await git(dir, "add", "-A");
  if (!add.ok) {
    throw new Error(`git add -A failed in worktree: ${markIfCut(add.stderr.trim(), 300)}`);
  }
  const names = await git(dir, "diff", "--cached", "--name-only");
  if (!names.ok) {
    throw new Error(`git diff failed in worktree: ${markIfCut(names.stderr.trim(), 300)}`);
  }
  const stat = await git(dir, "diff", "--cached", "--shortstat");
  return {
    files: names.stdout.split("\n").filter(Boolean),
    diffstat: stat.stdout.trim(),
  };
}

/** Best-effort removal for a clean worktree; a leftover tmp dir is not worth failing a run. */
export async function removeWorktree(repoRoot: string, dir: string): Promise<void> {
  await git(repoRoot, "worktree", "remove", "--force", dir);
}
