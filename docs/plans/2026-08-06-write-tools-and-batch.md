# subagents Write Support & Batch Scheduling — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Phase A — a delegate that can edit and create files inside a disposable git worktree, gated by the caller's test command, reporting `files_changed`/`diffstat`/`test`/`worktree` in the envelope. Phase B — `subagents batch`: N jobs, one rollup, models loaded once each, per-provider concurrency, a pollable progress file, and a one-shot escalation pass.

**Architecture:** Phase A extends the existing loop with two write tools and a per-run read-tracking session; the CLI wraps the loop in a worktree lifecycle (create at HEAD → run → collect diff → test gate → report). Phase B extracts the single-run path into `executeRun`, then adds a scheduler that groups jobs by (provider, model) and fans out within a group under a `max_in_flight` cap, plus escalation and a rollup built from per-job envelopes. The loop itself (`src/loop.ts`) needs no scheduling knowledge; tools still take a root and return `{content, truncated}`.

**Tech Stack:** Bun 1.3+, TypeScript (no build step), `bun:test`, the `git` CLI (worktrees). Zero runtime dependencies.

## Global Constraints

- **Zero runtime dependencies.** `devDependencies` may contain only `@types/bun` and `typescript`. `Bun.YAML` parses config, `Bun.spawn` runs git and the test gate, global `fetch` talks HTTP.
- **Mirror Claude Code's tool semantics exactly.** `edit_file` = Edit (unique exact-substring match, `replace_all` opt-in, read-before-edit). `write_file` = Write (overwrite requires a prior read). Deviation is a bug until proven otherwise.
- **Never truncate silently.** Every capped output carries an explicit marker naming what was withheld. This now includes test-gate output (marked cut for the transcript) and `files_changed` (entry-capped with an explicit remainder marker).
- **Prompt economy is a hard constraint.** Tool schemas and the system prompt are re-sent every turn. The write-mode system-prompt suffix and both new tool descriptions must stay as short as they can be while keeping every load-bearing instruction.
- **Termination is "assistant message with no tool calls".** Unchanged. No terminator tool.
- **Never overrun the caller's deadline; once a run starts, a valid envelope always reaches stdout.** Post-loop steps (worktree inspection, test gate, transcript write) are side channels — each is guarded so its failure degrades a field honestly instead of killing the envelope.
- **Path confinement:** every read path via `safePath` (realpath). Every write path via `safeWritePath` (Task 1), which realpaths the deepest *existing* ancestor first — a not-yet-existing target under a symlinked directory must not slip out of the root.
- **Writes land only in a detached git worktree created from HEAD.** No in-place write mode this round; a write profile with `worktree: false` is a config error. Corollary, documented everywhere user-facing: **the delegate sees the last commit, not the caller's uncommitted changes.**
- **Test-gate failure keeps the worktree and reports it** (`test.passed: false` + worktree path). Never revert — with worktree isolation the diff is the deliverable, and a failed-but-close diff is salvageable by the orchestrator. Task 9 updates `docs/design.md`, which currently says the opposite.
- **Every envelope field except `summary`/`detail` is bounded by construction.** Those two are shrunk by measurement (`shrinkField`); `MAX_ENVELOPE_CHARS` becomes 1200 in Task 7, with a both-sides test (bound holds AND usable content survives).
- Transcripts persist the **full message array**; test-gate output is stored in the transcript (`test_output`), never in the envelope.
- Runtime floor verified in repo: Bun 1.3.14. License MIT. Repository `https://github.com/andrhamm/subagents`. **Do not add a git remote or push.**

---

# Phase A — write support (Tasks 1–9)

### Task 1: Read-tracking session and `safeWritePath`

Two foundations with no user-visible behavior of their own: a per-run `RunSession` recording which files the delegate has read (the read-before-write rule both write tools enforce), and a write-safe path resolver closing the symlinked-ancestor hole `safePath` leaves open for not-yet-existing targets.

**Files:**
- Modify: `src/tools/types.ts`
- Modify: `src/tools/paths.ts`
- Modify: `src/tools/read.ts`
- Modify: `src/loop.ts`
- Test: `tests/tools/paths.test.ts` (create)
- Test: `tests/tools/read.test.ts` (append)
- Test: `tests/loop.test.ts` (append)

**Interfaces:**
- Consumes: `safePath` from `src/tools/paths.ts`; `Tool`, `ToolContext` from `src/tools/types.ts`; `runLoop`/`dispatch` internals from `src/loop.ts`.
- Produces: `interface RunSession { reads: Set<string> }`, `newSession(): RunSession`, `ToolContext.session?: RunSession` (all in `src/tools/types.ts`); `safeWritePath(root: string, rel: string): string` in `src/tools/paths.ts`. Tasks 2 and 3 rely on all four; Task 8's CLI relies on the loop supplying one session per run.

- [ ] **Step 1: Write the failing tests**

Create `tests/tools/paths.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { safeWritePath } from "../../src/tools/paths";

let root: string;
let realRoot: string;
let outside: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "subagents-paths-"));
  realRoot = realpathSync(root);
  outside = mkdtempSync(join(tmpdir(), "subagents-outside-"));
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "a.ts"), "x\n");
  // A directory that *looks* inside the root but is really a symlink out of
  // it. safePath catches this for existing targets (it realpaths them), but
  // returns a not-yet-existing target unresolved — which is exactly the
  // shape write_file creates. safeWritePath must catch it.
  symlinkSync(outside, join(root, "vendor"));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

describe("safeWritePath", () => {
  it("resolves an existing file inside the root", () => {
    expect(safeWritePath(root, "src/a.ts")).toBe(join(realRoot, "src", "a.ts"));
  });

  it("allows a new file in an existing directory", () => {
    expect(safeWritePath(root, "src/new.ts")).toBe(join(realRoot, "src", "new.ts"));
  });

  it("allows a new file under directories that do not exist yet", () => {
    expect(safeWritePath(root, "src/deep/nested/new.ts"))
      .toBe(join(realRoot, "src", "deep", "nested", "new.ts"));
  });

  it("rejects a new file under a symlinked directory pointing outside the root", () => {
    expect(() => safeWritePath(root, "vendor/evil.ts")).toThrow(/escapes root/);
  });

  it("rejects a relative escape", () => {
    expect(() => safeWritePath(root, "../evil.ts")).toThrow(/escapes root/);
  });

  it("rejects an absolute path outside the root", () => {
    expect(() => safeWritePath(root, "/etc/evil")).toThrow(/escapes root/);
  });
});
```

Append to `tests/tools/read.test.ts` (inside the existing file, after the `read_file` describe; add `newSession` to the imports from `../../src/tools/types` — a new import line — and reuse the existing `root`/`realRoot` fixtures):

```ts
import { newSession } from "../../src/tools/types";

describe("read_file session recording", () => {
  it("records a successful read into the session, keyed by realpath", async () => {
    const session = newSession();
    await readFile.run({ path: "src/small.ts" }, { root, session });
    expect(session.reads.has(join(realRoot, "src", "small.ts"))).toBe(true);
  });

  it("does not record a failed read", async () => {
    const session = newSession();
    await expect(
      readFile.run({ path: "src/missing.ts" }, { root, session }),
    ).rejects.toThrow();
    expect(session.reads.size).toBe(0);
  });

  it("runs without a session at all — read-only callers need no ceremony", async () => {
    const r = await readFile.run({ path: "src/small.ts" }, { root });
    expect(r.truncated).toBe(false);
  });
});
```

Append to `tests/loop.test.ts` (a new top-level describe; `ScriptedBackend`, `assistant`, and `base` already exist in the file):

```ts
describe("runLoop session", () => {
  it("supplies one shared session to every tool call in a run", async () => {
    const seen: unknown[] = [];
    const tool: Tool = {
      name: "t",
      schema: {
        type: "function",
        function: { name: "t", description: "d", parameters: { type: "object", properties: {} } },
      },
      async run(_args, ctx) {
        seen.push(ctx.session);
        return { content: "x", truncated: false };
      },
    };
    const backend = new ScriptedBackend([
      assistant(null, [["c1", "t", "{}"], ["c2", "t", "{}"]]),
      assistant(null, [["c3", "t", "{}"]]),
      assistant("done"),
    ]);
    await runLoop({ ...base, backend, tools: [tool] });
    expect(seen).toHaveLength(3);
    expect(seen[0]).toBeDefined();
    expect(seen[1]).toBe(seen[0]);
    expect(seen[2]).toBe(seen[0]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test tests/tools/paths.test.ts tests/tools/read.test.ts tests/loop.test.ts`
Expected: FAIL — `safeWritePath` and `newSession` are not exported; the session test fails on `ctx.session` being undefined.

- [ ] **Step 3: Extend `src/tools/types.ts`**

```ts
import type { ToolSchema } from "../types";

export interface ToolResult {
  content: string;
  /** True when output was cut short. Drives the envelope's truncation count. */
  truncated: boolean;
}

/**
 * Per-run state shared by every tool call in one loop. `reads` holds the
 * realpath'd absolute path of every file successfully read this run;
 * edit_file and write_file refuse to touch a file that is not in it —
 * Claude Code's read-before-write rule.
 */
export interface RunSession {
  reads: Set<string>;
}

export function newSession(): RunSession {
  return { reads: new Set() };
}

export interface ToolContext {
  root: string;
  /** Absent only in bare unit tests; runLoop always supplies one. */
  session?: RunSession;
}

export interface Tool {
  name: string;
  schema: ToolSchema;
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}
```

- [ ] **Step 4: Add `safeWritePath` to `src/tools/paths.ts`**

Replace the whole file with:

```ts
import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";

/**
 * Resolve `rel` against `root` and refuse anything that escapes it.
 * Existing targets are realpath'd so a symlink cannot lead outside.
 */
export function safePath(root: string, rel: string): string {
  const rootReal = realpathSync(root);
  const target = resolve(rootReal, rel);
  const check = existsSync(target) ? realpathSync(target) : target;
  if (check !== rootReal && !check.startsWith(rootReal + sep)) {
    throw new Error(`path escapes root: ${rel}`);
  }
  return check;
}

/**
 * Like safePath, but for a target that may not exist yet (write_file
 * creating a new file). safePath returns a non-existing target unresolved,
 * which leaves one hole: a symlinked *ancestor* directory inside the root
 * can point outside it, and the unresolved path still starts with the root
 * prefix. Realpath the deepest existing ancestor first, re-append the
 * not-yet-existing remainder, and check that instead.
 */
export function safeWritePath(root: string, rel: string): string {
  const rootReal = realpathSync(root);
  const target = resolve(rootReal, rel);

  let ancestor = target;
  const remainder: string[] = [];
  while (!existsSync(ancestor)) {
    const parent = dirname(ancestor);
    if (parent === ancestor) break; // reached the filesystem root
    remainder.unshift(basename(ancestor));
    ancestor = parent;
  }
  const real = existsSync(ancestor) ? realpathSync(ancestor) : ancestor;
  const check = remainder.length ? join(real, ...remainder) : real;

  if (check !== rootReal && !check.startsWith(rootReal + sep)) {
    throw new Error(`path escapes root: ${rel}`);
  }
  return check;
}
```

- [ ] **Step 5: Record reads in `src/tools/read.ts`**

In `readFile.run`, immediately after the `limit` validation block (after the `throw` for a bad `limit`, before `const window = ...`), insert:

```ts
    // Only a read that actually returned content counts for the
    // read-before-write rule — a validation error above never reaches here.
    ctx.session?.reads.add(path);
```

- [ ] **Step 6: Thread the session through `src/loop.ts`**

Three edits:

1. Extend the tools-types import:

```ts
import { newSession, type RunSession, type Tool } from "./tools/types";
```

2. In `runLoop`, right after `const byName = ...`, add:

```ts
  const session = newSession();
```

and change the dispatch call inside the tool-calls loop to pass it:

```ts
        content: await dispatch(call.function.name, call.function.arguments, byName, o,
          session, () => { truncations++; }),
```

3. Change `dispatch`'s signature and its `tool.run` call:

```ts
async function dispatch(
  name: string,
  rawArgs: string,
  byName: Map<string, Tool>,
  o: LoopOptions,
  session: RunSession,
  onTruncated: () => void,
): Promise<string> {
```

```ts
    const result = await tool.run(args, { root: o.root, session });
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `bun test tests/tools/paths.test.ts tests/tools/read.test.ts tests/loop.test.ts`
Expected: PASS. Then run `bun test` — the whole suite must stay green (the session field is optional, so no existing test changes).

- [ ] **Step 8: Typecheck**

Run: `bun run typecheck` (run `bun install` first if `node_modules` is absent)
Expected: no output, exit 0.

- [ ] **Step 9: Commit**

```bash
git add src/tools/types.ts src/tools/paths.ts src/tools/read.ts src/loop.ts tests/tools/paths.test.ts tests/tools/read.test.ts tests/loop.test.ts
git commit -m "feat: per-run read tracking and a write-safe path resolver

Two foundations for write tools. The session records what the delegate has
actually read, keyed by realpath, so edit/write can enforce read-before-write.
safeWritePath realpaths the deepest existing ancestor of a not-yet-existing
target — safePath returns such targets unresolved, which would let a
symlinked directory inside the root smuggle a new file out of it."
```

---

### Task 2: `edit_file`

Claude Code's Edit, exactly: exact-substring replace on a file the delegate has already read, `old_string` matching exactly once unless `replace_all`, and instructive errors for every refusal — the error text is what teaches a mid-loop model how to retry.

**Files:**
- Create: `src/tools/edit.ts`
- Test: `tests/tools/edit.test.ts`

**Interfaces:**
- Consumes: `Tool`, `ToolResult`, `ToolContext`, `RunSession` from `src/tools/types.ts`; `safePath` from `src/tools/paths.ts`.
- Produces: `editFile: Tool` (name `"edit_file"`). Task 4 registers it; Task 8's e2e drives it through the CLI.

- [ ] **Step 1: Write the failing tests**

Create `tests/tools/edit.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newSession, type RunSession } from "../../src/tools/types";
import { readFile } from "../../src/tools/read";
import { editFile } from "../../src/tools/edit";

let root: string;
let session: RunSession;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "subagents-edit-"));
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "a.ts"), "const a = 1;\nconst b = 2;\nconst c = 3;\n");
  writeFileSync(join(root, "src", "dup.ts"), "x();\nx();\nx();\n");
  session = newSession();
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

/** Populate the session the way a real run does — through read_file itself,
 * so this suite locks the two tools to the same path-key format. */
async function read(path: string): Promise<void> {
  await readFile.run({ path }, { root, session });
}

describe("edit_file", () => {
  it("replaces a unique match and shows a numbered snippet of the result", async () => {
    await read("src/a.ts");
    const r = await editFile.run(
      { path: "src/a.ts", old_string: "const b = 2;", new_string: "const b = 20;" },
      { root, session },
    );
    expect(r.truncated).toBe(false);
    expect(r.content).toContain("Edited src/a.ts (1 replacement)");
    expect(r.content).toContain("2\tconst b = 20;");
    expect(await Bun.file(join(root, "src", "a.ts")).text())
      .toBe("const a = 1;\nconst b = 20;\nconst c = 3;\n");
  });

  it("refuses to edit a file not read this session, and says what to do", async () => {
    await expect(
      editFile.run(
        { path: "src/a.ts", old_string: "const a = 1;", new_string: "const a = 9;" },
        { root, session },
      ),
    ).rejects.toThrow(/read_file it first/);
  });

  it("refuses an identical old_string and new_string", async () => {
    await read("src/a.ts");
    await expect(
      editFile.run(
        { path: "src/a.ts", old_string: "const a = 1;", new_string: "const a = 1;" },
        { root, session },
      ),
    ).rejects.toThrow(/identical/);
  });

  it("refuses an empty old_string", async () => {
    await read("src/a.ts");
    await expect(
      editFile.run({ path: "src/a.ts", old_string: "", new_string: "x" }, { root, session }),
    ).rejects.toThrow(/empty/);
  });

  it("reports a missing match and tells the model to re-read", async () => {
    await read("src/a.ts");
    await expect(
      editFile.run(
        { path: "src/a.ts", old_string: "const z = 9;", new_string: "y" },
        { root, session },
      ),
    ).rejects.toThrow(/not found.*re-read/is);
  });

  it("names the occurrence count when the match is ambiguous", async () => {
    await read("src/dup.ts");
    await expect(
      editFile.run({ path: "src/dup.ts", old_string: "x();", new_string: "y();" }, { root, session }),
    ).rejects.toThrow(/matches 3 times/);
  });

  it("replace_all replaces every occurrence and reports the count", async () => {
    await read("src/dup.ts");
    const r = await editFile.run(
      { path: "src/dup.ts", old_string: "x();", new_string: "y();", replace_all: true },
      { root, session },
    );
    expect(r.content).toContain("Edited src/dup.ts (3 replacements)");
    expect(await Bun.file(join(root, "src", "dup.ts")).text()).toBe("y();\ny();\ny();\n");
  });

  it("reports a nonexistent file as such, not as unread", async () => {
    await expect(
      editFile.run({ path: "src/ghost.ts", old_string: "a", new_string: "b" }, { root, session }),
    ).rejects.toThrow(/file not found/);
  });

  it("rejects a path escaping the root", async () => {
    await expect(
      editFile.run({ path: "../evil.ts", old_string: "a", new_string: "b" }, { root, session }),
    ).rejects.toThrow(/escapes root/);
  });

  it("advertises its parameters and the read-first rule in its schema", () => {
    const props = editFile.schema.function.parameters.properties;
    expect(Object.keys(props).sort()).toEqual(["new_string", "old_string", "path", "replace_all"]);
    expect(editFile.schema.function.description).toContain("read_file");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test tests/tools/edit.test.ts`
Expected: FAIL — cannot resolve `../../src/tools/edit`.

- [ ] **Step 3: Create `src/tools/edit.ts`**

```ts
import type { Tool, ToolContext, ToolResult } from "./types";
import { safePath } from "./paths";

/** Lines of context shown around the first change in the confirmation snippet. */
const SNIPPET_CONTEXT = 3;

/** Non-overlapping occurrence count — the same semantics replaceAll applies. */
function countOccurrences(text: string, needle: string): number {
  let count = 0;
  let i = text.indexOf(needle);
  while (i !== -1) {
    count++;
    i = text.indexOf(needle, i + needle.length);
  }
  return count;
}

/**
 * Line-numbered window around the first changed line of the *updated* text,
 * so the model can verify its edit landed without paying for a re-read.
 */
function snippet(updated: string, changeIndex: number): string {
  const firstChangedLine = updated.slice(0, changeIndex).split("\n").length; // 1-based
  const lines = updated.split("\n");
  const start = Math.max(1, firstChangedLine - SNIPPET_CONTEXT);
  const end = Math.min(lines.length, firstChangedLine + SNIPPET_CONTEXT);
  return lines
    .slice(start - 1, end)
    .map((line, i) => `${String(start + i).padStart(6)}\t${line}`)
    .join("\n");
}

export const editFile: Tool = {
  name: "edit_file",
  schema: {
    type: "function",
    function: {
      name: "edit_file",
      description:
        "Replace old_string with new_string in a file already read with read_file. " +
        "old_string must match exactly once; set replace_all to change every occurrence.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path relative to the repo root." },
          old_string: { type: "string", description: "Exact text to replace, including whitespace." },
          new_string: { type: "string", description: "Replacement text." },
          replace_all: { type: "boolean", description: "Replace every occurrence. Default false." },
        },
        required: ["path", "old_string", "new_string"],
      },
    },
  },

  async run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const rel = String(args["path"]);
    const path = safePath(ctx.root, rel);
    const oldStr = String(args["old_string"]);
    const newStr = String(args["new_string"]);

    if (oldStr === "") {
      throw new Error("old_string is empty. To create a file, use write_file.");
    }
    if (oldStr === newStr) {
      throw new Error("old_string and new_string are identical — nothing to change.");
    }

    const file = Bun.file(path);
    if (!(await file.exists())) {
      throw new Error(`file not found: ${rel}. write_file creates new files.`);
    }
    // Read-before-edit, Claude Code's rule. The realpath key matches what
    // read_file recorded, because both go through safePath. External
    // modification between read and edit cannot happen here — one agent,
    // isolated worktree — so no staleness check is needed.
    if (!(ctx.session?.reads.has(path) ?? false)) {
      throw new Error(`cannot edit ${rel}: not yet read. read_file it first, then retry.`);
    }

    const text = await file.text();
    const n = countOccurrences(text, oldStr);
    if (n === 0) {
      throw new Error(
        `old_string not found in ${rel}. Re-read the file — the text must match exactly, ` +
          "including whitespace and line breaks.",
      );
    }
    const replaceAll = args["replace_all"] === true;
    if (n > 1 && !replaceAll) {
      throw new Error(
        `old_string matches ${n} times in ${rel}. Add surrounding context to make it ` +
          "unique, or set replace_all.",
      );
    }

    const changeIndex = text.indexOf(oldStr);
    const updated = replaceAll ? text.replaceAll(oldStr, newStr) : text.replace(oldStr, newStr);
    await Bun.write(path, updated);

    const count = replaceAll ? n : 1;
    return {
      content:
        `Edited ${rel} (${count} replacement${count === 1 ? "" : "s"}).\n` +
        snippet(updated, changeIndex),
      truncated: false,
    };
  },
};
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test tests/tools/edit.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 5: Typecheck, then commit**

Run: `bun run typecheck` — silent, exit 0.

```bash
git add src/tools/edit.ts tests/tools/edit.test.ts
git commit -m "feat: edit_file with Claude Code's exact-match semantics

Unique-match enforcement and read-before-edit, with errors written for the
model that has to act on them: 'matches 3 times' says add context or set
replace_all; 'not found' says re-read before retrying. The confirmation
snippet gives line-numbered proof the edit landed without a paid re-read."
```

---

### Task 3: `write_file`

Claude Code's Write: whole-file create or overwrite, where overwriting a file the delegate hasn't read is refused. Uses `safeWritePath` because the target may not exist yet.

**Files:**
- Modify: `src/tools/read.ts` (export `toLines` — one-word change)
- Create: `src/tools/write.ts`
- Test: `tests/tools/write.test.ts`

**Interfaces:**
- Consumes: `Tool`, `ToolResult`, `ToolContext` from `src/tools/types.ts`; `safeWritePath` from `src/tools/paths.ts`; `toLines` from `src/tools/read.ts`.
- Produces: `writeFile: Tool` (name `"write_file"`). Task 4 registers it.

- [ ] **Step 1: Write the failing tests**

Create `tests/tools/write.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newSession, type RunSession } from "../../src/tools/types";
import { readFile } from "../../src/tools/read";
import { editFile } from "../../src/tools/edit";
import { writeFile } from "../../src/tools/write";

let root: string;
let outside: string;
let session: RunSession;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "subagents-write-"));
  outside = mkdtempSync(join(tmpdir(), "subagents-write-out-"));
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "a.ts"), "old content\n");
  symlinkSync(outside, join(root, "vendor"));
  session = newSession();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

describe("write_file", () => {
  it("creates a new file and reports its line count", async () => {
    const r = await writeFile.run(
      { path: "src/new.ts", content: "line 1\nline 2\n" },
      { root, session },
    );
    expect(r.truncated).toBe(false);
    expect(r.content).toBe("Wrote src/new.ts (2 lines).");
    expect(await Bun.file(join(root, "src", "new.ts")).text()).toBe("line 1\nline 2\n");
  });

  it("creates parent directories for a nested new path", async () => {
    await writeFile.run(
      { path: "src/deep/nested/new.ts", content: "x\n" },
      { root, session },
    );
    expect(existsSync(join(root, "src", "deep", "nested", "new.ts"))).toBe(true);
  });

  it("refuses to overwrite a file not read this session", async () => {
    await expect(
      writeFile.run({ path: "src/a.ts", content: "clobbered\n" }, { root, session }),
    ).rejects.toThrow(/read_file it first/);
    expect(await Bun.file(join(root, "src", "a.ts")).text()).toBe("old content\n");
  });

  it("overwrites after a read", async () => {
    await readFile.run({ path: "src/a.ts" }, { root, session });
    const r = await writeFile.run(
      { path: "src/a.ts", content: "new content\n" },
      { root, session },
    );
    expect(r.content).toBe("Wrote src/a.ts (1 line).");
    expect(await Bun.file(join(root, "src", "a.ts")).text()).toBe("new content\n");
  });

  it("marks the written file readable-for-edit — no fresh read needed", async () => {
    await writeFile.run({ path: "src/gen.ts", content: "const g = 1;\n" }, { root, session });
    const r = await editFile.run(
      { path: "src/gen.ts", old_string: "const g = 1;", new_string: "const g = 2;" },
      { root, session },
    );
    expect(r.content).toContain("Edited src/gen.ts");
  });

  it("writes an empty file and says 0 lines", async () => {
    const r = await writeFile.run({ path: "src/empty.ts", content: "" }, { root, session });
    expect(r.content).toBe("Wrote src/empty.ts (0 lines).");
  });

  it("rejects a new file under a symlinked directory pointing outside the root", async () => {
    await expect(
      writeFile.run({ path: "vendor/evil.ts", content: "x" }, { root, session }),
    ).rejects.toThrow(/escapes root/);
    expect(existsSync(join(outside, "evil.ts"))).toBe(false);
  });

  it("rejects a relative escape", async () => {
    await expect(
      writeFile.run({ path: "../evil.ts", content: "x" }, { root, session }),
    ).rejects.toThrow(/escapes root/);
  });

  it("advertises overwrite-requires-read in its schema", () => {
    const props = writeFile.schema.function.parameters.properties;
    expect(Object.keys(props).sort()).toEqual(["content", "path"]);
    expect(writeFile.schema.function.description).toContain("read");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test tests/tools/write.test.ts`
Expected: FAIL — cannot resolve `../../src/tools/write`.

- [ ] **Step 3: Export `toLines` from `src/tools/read.ts`**

Change the existing private helper's declaration (body unchanged):

```ts
/** Split into lines without inventing a final empty line for a trailing newline. */
export function toLines(text: string): string[] {
```

- [ ] **Step 4: Create `src/tools/write.ts`**

```ts
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Tool, ToolContext, ToolResult } from "./types";
import { safeWritePath } from "./paths";
import { toLines } from "./read";

export const writeFile: Tool = {
  name: "write_file",
  schema: {
    type: "function",
    function: {
      name: "write_file",
      description:
        "Create a file, or overwrite one already read with read_file. " +
        "Prefer edit_file for changing an existing file.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path relative to the repo root." },
          content: { type: "string", description: "Full file content." },
        },
        required: ["path", "content"],
      },
    },
  },

  async run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const rel = String(args["path"]);
    // safeWritePath, not safePath: the target may not exist yet, and only
    // safeWritePath resolves a symlinked ancestor before the containment check.
    const path = safeWritePath(ctx.root, rel);
    const content = String(args["content"]);

    if (existsSync(path) && !(ctx.session?.reads.has(path) ?? false)) {
      throw new Error(
        `cannot overwrite ${rel}: not yet read. read_file it first — ` +
          "or use edit_file, which is safer for changing an existing file.",
      );
    }

    mkdirSync(dirname(path), { recursive: true });
    await Bun.write(path, content);
    // The delegate now knows this file's exact content — an immediate
    // edit_file must not demand a redundant paid re-read.
    ctx.session?.reads.add(path);

    const lines = content === "" ? 0 : toLines(content).length;
    return {
      content: `Wrote ${rel} (${lines} line${lines === 1 ? "" : "s"}).`,
      truncated: false,
    };
  },
};
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun test tests/tools/write.test.ts`
Expected: PASS, 9 tests. Then `bun test` — whole suite green.

- [ ] **Step 6: Typecheck, then commit**

Run: `bun run typecheck` — silent, exit 0.

```bash
git add src/tools/read.ts src/tools/write.ts tests/tools/write.test.ts
git commit -m "feat: write_file with overwrite-requires-read

Whole-file create or overwrite. Overwriting a file the delegate has not read
is refused — the same rule Claude Code's Write tool enforces, and the only
thing standing between a model's stale mental copy and silent data loss.
Uses safeWritePath: the target may not exist yet, so the deepest existing
ancestor is realpath'd before the containment check."
```

---

### Task 4: Registry and config — write profiles

Register both tools, and teach config the write-profile rules: `worktree` defaults on exactly when a profile carries a write tool, `worktree: false` on such a profile is an error (in-place writes are not shipped), and `test_cmd`/`test_timeout_ms` resolve with defaults. Also close the adjacent open ledger item in the same gate: a required config section that is an *array* must be rejected, not waved through.

**Files:**
- Modify: `src/tools/registry.ts`
- Modify: `src/config.ts`
- Test: `tests/config.test.ts` (append)
- Test: `tests/loop.test.ts` (append to the existing `resolveTools` describe)

**Interfaces:**
- Consumes: `editFile` from `src/tools/edit.ts`, `writeFile` from `src/tools/write.ts`.
- Produces: `WRITE_TOOL_NAMES: ReadonlySet<string>` and `hasWriteTools(names: string[]): boolean` from `src/tools/registry.ts`; `ProfileConfig.worktree?/test_cmd?`, `Defaults.test_timeout_ms?`, `ResolvedRun.worktree: boolean`, `ResolvedRun.testCmd?: string`, `ResolvedRun.testTimeoutMs: number`, `DEFAULTS.testTimeoutMs = 120_000` from `src/config.ts`. Task 8 branches on `run.worktree`, `run.testCmd`, `run.testTimeoutMs`, and `hasWriteTools`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/config.test.ts`:

```ts
const YAML_WRITES = `
providers:
  local: { base_url: "http://127.0.0.1:1234/v1" }
tiers:
  cheap: { provider: local, model: "m" }
profiles:
  digest:  { tools: [read_file, glob, grep], tier: cheap }
  fix:     { tools: [read_file, edit_file, write_file], tier: cheap, test_cmd: "bun test" }
  scratch: { tools: [read_file, write_file], tier: cheap, worktree: false }
  boxed:   { tools: [read_file], tier: cheap, worktree: true }
defaults:
  test_timeout_ms: 5000
`;

describe("write profiles", () => {
  it("defaults worktree off for a read-only profile", () => {
    const r = resolveProfile(parseConfig(YAML_WRITES), "digest");
    expect(r.worktree).toBe(false);
    expect(r.testCmd).toBeUndefined();
  });

  it("defaults worktree on when the profile has a write tool", () => {
    const r = resolveProfile(parseConfig(YAML_WRITES), "fix");
    expect(r.worktree).toBe(true);
    expect(r.testCmd).toBe("bun test");
  });

  it("rejects write tools with worktree explicitly off — in-place writes are not shipped", () => {
    expect(() => resolveProfile(parseConfig(YAML_WRITES), "scratch"))
      .toThrow(/worktree/);
  });

  it("allows an explicit worktree on a read-only profile", () => {
    expect(resolveProfile(parseConfig(YAML_WRITES), "boxed").worktree).toBe(true);
  });

  it("resolves test_timeout_ms from defaults, with a built-in fallback", () => {
    expect(resolveProfile(parseConfig(YAML_WRITES), "fix").testTimeoutMs).toBe(5000);
    expect(resolveProfile(parseConfig(YAML_OK), "digest").testTimeoutMs)
      .toBe(DEFAULTS.testTimeoutMs);
  });
});

describe("parseConfig section shapes", () => {
  // typeof [] === "object", so the original gate accepted `providers: []`
  // and failed later with a vaguer "unknown provider" — the ledger's oldest
  // open finding.
  it("rejects a required section that is an array rather than a mapping", () => {
    expect(() => parseConfig("providers: []\ntiers: {}\nprofiles: {}\n"))
      .toThrow(/invalid section 'providers'/);
  });
});
```

Append inside the existing `describe("resolveTools", ...)` block in `tests/loop.test.ts`:

```ts
  it("resolves the write tools by name", () => {
    const names = resolveTools(["edit_file", "write_file"]).map((t) => t.name);
    expect(names).toEqual(["edit_file", "write_file"]);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test tests/config.test.ts tests/loop.test.ts`
Expected: FAIL — `worktree`/`testCmd`/`testTimeoutMs` are not on `ResolvedRun`; `edit_file` is an unknown tool; the array-section config parses without error.

- [ ] **Step 3: Register the tools in `src/tools/registry.ts`**

Replace the imports and `ALL_TOOLS`, and add the two exports:

```ts
import type { Tool } from "./types";
import { readFile } from "./read";
import { glob, grep, listDir } from "./search";
import { editFile } from "./edit";
import { writeFile } from "./write";

export const ALL_TOOLS: Record<string, Tool> = {
  [readFile.name]: readFile,
  [glob.name]: glob,
  [grep.name]: grep,
  [listDir.name]: listDir,
  [editFile.name]: editFile,
  [writeFile.name]: writeFile,
};

/** Tools that modify the filesystem. Profiles carrying any of these get worktree isolation. */
export const WRITE_TOOL_NAMES: ReadonlySet<string> = new Set([editFile.name, writeFile.name]);

export function hasWriteTools(names: string[]): boolean {
  return names.some((n) => WRITE_TOOL_NAMES.has(n));
}
```

(`resolveTools` below stays exactly as it is.)

- [ ] **Step 4: Extend `src/config.ts`**

Four edits:

1. Import the registry helper at the top (no cycle: registry imports only tools, which import nothing from config):

```ts
import { hasWriteTools } from "./tools/registry";
```

2. Extend the interfaces and defaults:

```ts
export interface ProfileConfig {
  tools: string[];
  tier: string;
  /** Run in a detached git worktree. Defaults to true iff the profile has a write tool. */
  worktree?: boolean;
  /** Command the harness runs after the delegate changed files. */
  test_cmd?: string;
}
export interface Defaults {
  max_turns?: number;
  max_tokens?: number;
  timeout_ms?: number;
  test_timeout_ms?: number;
}
```

```ts
export interface ResolvedRun {
  baseUrl: string;
  kind: "openai" | "lmstudio";
  model: string;
  sampling: SamplingParams;
  tools: string[];
  maxTurns: number;
  maxTokens: number;
  timeoutMs: number;
  worktree: boolean;
  testCmd?: string;
  testTimeoutMs: number;
}
```

```ts
export const DEFAULTS = {
  maxTurns: 20,
  maxTokens: 8000,
  timeoutMs: 300_000,
  testTimeoutMs: 120_000,
} as const;
```

3. Harden the section gate in `parseConfig` (`typeof [] === "object"` let arrays through):

```ts
  for (const section of REQUIRED_SECTIONS) {
    const value = cfg[section] as unknown;
    if (
      value === undefined || value === null ||
      typeof value !== "object" || Array.isArray(value)
    ) {
      throw new Error(`config: missing or invalid section '${section}' (must be a mapping)`);
    }
  }
```

(The existing "rejects a config missing a required section" test asserts `/profiles/`, which this message still satisfies.)

4. Resolve the write-profile fields in `resolveProfile`, just before the `return`:

```ts
  const writes = hasWriteTools(profile.tools);
  const worktree = profile.worktree ?? writes;
  if (writes && !worktree) {
    throw new Error(
      `profile '${profileName}' has write tools but 'worktree: false' — in-place ` +
        "writes are not supported; drop the override or the write tools",
    );
  }
```

and extend the returned object:

```ts
    worktree,
    ...(profile.test_cmd !== undefined ? { testCmd: profile.test_cmd } : {}),
    testTimeoutMs: d.test_timeout_ms ?? DEFAULTS.testTimeoutMs,
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun test tests/config.test.ts tests/loop.test.ts`
Expected: PASS. Then `bun test` — whole suite green.

- [ ] **Step 6: Typecheck, then commit**

Run: `bun run typecheck` — silent, exit 0.

```bash
git add src/tools/registry.ts src/config.ts tests/config.test.ts tests/loop.test.ts
git commit -m "feat: write profiles in config — worktree default-on, test gate settings

A profile with a write tool gets worktree isolation by default and cannot
opt out: in-place writes are not shipped, and a config that silently
accepted 'worktree: false' would promise exactly that. Also rejects a
required config section that parses as an array — typeof [] is 'object',
so the old gate accepted 'providers: []' and failed later with a vaguer
'unknown provider'."
```

---

### Task 5: Worktree lifecycle

A detached git worktree at HEAD: create, collect what changed (including new files), remove when clean. All through the `git` CLI via `Bun.spawn` — no dependency, and git's own errors surface verbatim.

**Files:**
- Create: `src/worktree.ts`
- Test: `tests/worktree.test.ts`

**Interfaces:**
- Consumes: `markIfCut` from `src/text.ts`.
- Produces: `assertGitRepo(root: string): Promise<void>`, `createWorktree(repoRoot: string, dir: string): Promise<void>`, `interface WorktreeChanges { files: string[]; diffstat: string }`, `collectChanges(dir: string): Promise<WorktreeChanges>`, `removeWorktree(repoRoot: string, dir: string): Promise<void>`. Task 8 consumes all of them.

- [ ] **Step 1: Write the failing tests**

Create `tests/worktree.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test tests/worktree.test.ts`
Expected: FAIL — cannot resolve `../src/worktree`.

- [ ] **Step 3: Create `src/worktree.ts`**

```ts
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test tests/worktree.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Typecheck, then commit**

Run: `bun run typecheck` — silent, exit 0.

```bash
git add src/worktree.ts tests/worktree.test.ts
git commit -m "feat: detached-worktree lifecycle for write runs

Create at HEAD, collect changes by staging the throwaway index (the only
way new files appear in a diff), remove when clean. One test pins the
documented caveat directly: the worktree sees the last commit, not the
caller's uncommitted edits — better invisible than corruptible."
```

---

### Task 6: Test gate

Run the caller's configured `test_cmd` in the worktree, with a timeout. Not a model-callable tool — the harness invokes it after the loop, which is why bash stays deferred without blocking the gate.

**Files:**
- Create: `src/testgate.ts`
- Test: `tests/testgate.test.ts`

**Interfaces:**
- Consumes: `markIfCut` from `src/text.ts`.
- Produces: `MAX_TEST_OUTPUT_CHARS = 10_000`, `interface TestGateResult { ran: true; passed: boolean; timedOut: boolean; cmd: string; output: string }`, `runTestGate(cmd: string, cwd: string, timeoutMs: number): Promise<TestGateResult>`. Task 8 consumes it; the envelope's `test` field (Task 7) carries `{ran, passed, cmd}` from it.

- [ ] **Step 1: Write the failing tests**

Create `tests/testgate.test.ts`:

```ts
import { describe, it, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_TEST_OUTPUT_CHARS, runTestGate } from "../src/testgate";

describe("runTestGate", () => {
  it("reports a passing command", async () => {
    const r = await runTestGate("exit 0", process.cwd(), 5000);
    expect(r).toMatchObject({ ran: true, passed: true, timedOut: false, cmd: "exit 0" });
  });

  it("reports a failing command and captures both output streams", async () => {
    const r = await runTestGate("echo out; echo err 1>&2; exit 1", process.cwd(), 5000);
    expect(r.passed).toBe(false);
    expect(r.timedOut).toBe(false);
    expect(r.output).toContain("out");
    expect(r.output).toContain("err");
  });

  it("runs in the given cwd", async () => {
    const dir = mkdtempSync(join(tmpdir(), "subagents-gate-"));
    try {
      const r = await runTestGate("pwd", dir, 5000);
      // macOS tmpdir realpath prefix differs (/private/var vs /var); match the leaf.
      expect(r.output).toContain(dir.split("/").pop()!);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("kills an overrunning command and says so", async () => {
    const r = await runTestGate("sleep 5", process.cwd(), 200);
    expect(r.timedOut).toBe(true);
    expect(r.passed).toBe(false);
  });

  it("caps captured output with an explicit marker, never silently", async () => {
    const r = await runTestGate(
      `head -c ${MAX_TEST_OUTPUT_CHARS + 5000} /dev/zero | tr '\\0' 'x'`,
      process.cwd(), 5000,
    );
    expect(r.output.length).toBeLessThanOrEqual(MAX_TEST_OUTPUT_CHARS + 1);
    expect(r.output.endsWith("…")).toBe(true);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test tests/testgate.test.ts`
Expected: FAIL — cannot resolve `../src/testgate`.

- [ ] **Step 3: Create `src/testgate.ts`**

```ts
import { markIfCut } from "./text";

/** Cap on captured test output. Marked when cut — it feeds the transcript, not the envelope. */
export const MAX_TEST_OUTPUT_CHARS = 10_000;

export interface TestGateResult {
  ran: true;
  passed: boolean;
  timedOut: boolean;
  cmd: string;
  /** Combined stdout + stderr, mark-if-cut at MAX_TEST_OUTPUT_CHARS. */
  output: string;
}

/**
 * Run the caller's test command in `cwd` (the worktree). Harness-invoked
 * only — deliberately not a model-callable tool. A timeout counts as a
 * failure but is reported distinctly, because the remedy differs: raise
 * test_timeout_ms rather than fix the code.
 */
export async function runTestGate(
  cmd: string, cwd: string, timeoutMs: number,
): Promise<TestGateResult> {
  const proc = Bun.spawn(["sh", "-c", cmd], { cwd, stdout: "pipe", stderr: "pipe" });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, timeoutMs);

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  clearTimeout(timer);

  const combined = `${stdout}${stderr ? `\n${stderr}` : ""}`.trim();
  return {
    ran: true,
    passed: !timedOut && code === 0,
    timedOut,
    cmd,
    output: markIfCut(combined, MAX_TEST_OUTPUT_CHARS),
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test tests/testgate.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Typecheck, then commit**

Run: `bun run typecheck` — silent, exit 0.

```bash
git add src/testgate.ts tests/testgate.test.ts
git commit -m "feat: harness-invoked test gate with timeout

Runs the profile's test_cmd in the worktree after the loop. Not a tool the
model can call — that keeps bash out of scope without losing the gate. A
timeout is a distinct failure shape because its remedy is different, and
captured output is mark-if-cut like every other bounded thing here."
```

---

### Task 7: Envelope and transcript — write fields, 1200-char bound

Add the write-outcome fields the orchestrator acts on, and raise `MAX_ENVELOPE_CHARS` to 1200. The measured problem with 600: the fixed fields eat ~200 chars, and a 20-item citation list came back with 6 items and a truncation marker — the caller then reads the transcript, paying the context delegation exists to save. Every new field is bounded by construction so `shrinkField` still only ever touches `summary`/`detail`.

**Files:**
- Modify: `src/envelope.ts`
- Modify: `src/transcript.ts`
- Test: `tests/envelope.test.ts`

**Interfaces:**
- Consumes: `LoopResult` from `src/loop.ts`; `TestGateResult` shape from Task 6 (only `{ran, passed, cmd}` crosses into the envelope).
- Produces: exported `MAX_ENVELOPE_CHARS = 1200`, `MAX_FILES_CHANGED = 10`, `interface EnvelopeTest { ran: boolean; passed: boolean; cmd: string }`, `interface WriteOutcome { files: string[]; diffstat: string; worktree: string; test?: EnvelopeTest }`, `Envelope.files_changed?/diffstat?/test?/worktree?`, `EnvelopeInputs.writes?: WriteOutcome`; `TranscriptData.test_output?: string`. Task 8 passes `writes` and `test_output`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/envelope.test.ts` (and extend its import line: `import { buildEnvelope, MAX_ENVELOPE_CHARS, MAX_FILES_CHANGED } from "../src/envelope";`):

```ts
describe("write outcome fields", () => {
  const writes = {
    files: ["src/a.ts", "src/b.ts"],
    diffstat: "2 files changed, 5 insertions(+), 1 deletion(-)",
    worktree: "/tmp/subagents-wt-1",
  };

  it("carries files_changed, diffstat and worktree when a write run changed files", () => {
    const e = buildEnvelope(result, { wallSecs: 1, transcript: "/t", contextLimit: null, writes });
    expect(e.files_changed).toEqual(["src/a.ts", "src/b.ts"]);
    expect(e.diffstat).toBe(writes.diffstat);
    expect(e.worktree).toBe("/tmp/subagents-wt-1");
    expect(e.test).toBeUndefined();
  });

  it("omits every write field on a read-only run", () => {
    const e = buildEnvelope(result, { wallSecs: 1, transcript: "/t", contextLimit: null });
    expect(e.files_changed).toBeUndefined();
    expect(e.diffstat).toBeUndefined();
    expect(e.worktree).toBeUndefined();
    expect(e.test).toBeUndefined();
  });

  it("caps files_changed with an explicit remainder marker, never silently", () => {
    const files = Array.from({ length: 14 }, (_, i) => `src/f${i}.ts`);
    const e = buildEnvelope(result, {
      wallSecs: 1, transcript: "/t", contextLimit: null,
      writes: { ...writes, files },
    });
    expect(e.files_changed).toHaveLength(MAX_FILES_CHANGED + 1);
    expect(e.files_changed![MAX_FILES_CHANGED]).toBe("…+4 more");
  });

  it("carries the test gate verdict", () => {
    const e = buildEnvelope(result, {
      wallSecs: 1, transcript: "/t", contextLimit: null,
      writes: { ...writes, test: { ran: true, passed: false, cmd: "bun test" } },
    });
    expect(e.test).toEqual({ ran: true, passed: false, cmd: "bun test" });
  });

  it("stays under the bound with every write field present and a long summary — both sides", () => {
    const e = buildEnvelope(
      { ...result, summary: "S".repeat(5000) },
      {
        wallSecs: 1, transcript: "/t", contextLimit: 32768,
        writes: { ...writes, test: { ran: true, passed: true, cmd: "bun test" } },
      },
    );
    expect(JSON.stringify(e).length).toBeLessThan(MAX_ENVELOPE_CHARS);
    // The bound must not be satisfied by gutting the field the caller reads.
    expect(e.summary.length).toBeGreaterThan(400);
  });
});
```

Then two mechanical updates to the existing tests in the same file:

1. Every literal `600` becomes `MAX_ENVELOPE_CHARS` — nine sites: the `toBeLessThan(600)` assertions (lines currently 112, 125, 144, 186, 224, 241, 263) and the two rig derivations `const over = fullLen - 600 + 1;` (lines currently 174, 213). The rig math must track the real bound or the planted surrogate pair lands nowhere near the cut.
2. In the `writeTranscript` describe, add:

```ts
  it("persists test gate output when present", async () => {
    const dir = mkdtempSync(join(tmpdir(), "subagents-tr2-"));
    const path = join(dir, "t.json");
    await writeTranscript(path, {
      model: "m", task: "t", status: "ok",
      messages: result.messages, usage: result.usage,
      test_output: "1 fail\nexpected 2, got 3",
    });
    const back = await Bun.file(path).json();
    expect(back.test_output).toContain("expected 2");
    rmSync(dir, { recursive: true, force: true });
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test tests/envelope.test.ts`
Expected: FAIL — `MAX_ENVELOPE_CHARS`/`MAX_FILES_CHANGED` are not exported; the write-fields tests fail on missing fields; `test_output` is not a known `TranscriptData` property (typecheck failure counts).

- [ ] **Step 3: Extend `src/envelope.ts`**

Five edits:

1. Export the bound, raised, with the measurement that forced it:

```ts
// The envelope's small size is the entire reason it exists — a measured run
// burned 165,362 delegate tokens and returned ~850 to the caller. But 600
// was too small once measured against real answers: the fixed fields eat
// ~200 chars, and a 20-item citation list came back with 6 items and a
// truncation marker, sending the caller to the transcript — the exact cost
// the envelope exists to avoid. 1200 (~300 tokens) holds the full list and
// every write field. `summary` and `detail` remain the only fields whose
// length the delegate controls, so they are still the only ones shrunk.
export const MAX_ENVELOPE_CHARS = 1200;
export const MAX_FILES_CHANGED = 10;
```

(Delete the old `const MAX_ENVELOPE_CHARS = 600;` line and its comment.)

2. New shapes above `Envelope`:

```ts
export interface EnvelopeTest {
  ran: boolean;
  passed: boolean;
  cmd: string;
}

export interface WriteOutcome {
  /** Root-relative changed paths, from git. Entry-capped at MAX_FILES_CHANGED in the envelope. */
  files: string[];
  /** git --shortstat line; may carry an inspection-failure notice instead. */
  diffstat: string;
  /** The kept worktree's path — the diff lives there. */
  worktree: string;
  test?: EnvelopeTest;
}
```

3. Extend `Envelope` (after `truncations`):

```ts
  files_changed?: string[];
  diffstat?: string;
  test?: EnvelopeTest;
  worktree?: string;
```

4. Extend `EnvelopeInputs`:

```ts
export interface EnvelopeInputs {
  wallSecs: number;
  transcript: string;
  contextLimit: number | null;
  writes?: WriteOutcome;
}
```

5. In `buildEnvelope`, after the `envelope` literal and before the `shrinkField` calls:

```ts
  if (o.writes) {
    const { files } = o.writes;
    // Entry-capped with an explicit remainder — the never-truncate-silently
    // rule applies to the envelope itself. Pathological single-path lengths
    // are the delegate's doing and fall to the final backstop below.
    envelope.files_changed = files.length > MAX_FILES_CHANGED
      ? [...files.slice(0, MAX_FILES_CHANGED), `…+${files.length - MAX_FILES_CHANGED} more`]
      : files;
    envelope.diffstat = o.writes.diffstat;
    envelope.worktree = o.writes.worktree;
    if (o.writes.test) envelope.test = o.writes.test;
  }
```

- [ ] **Step 4: Extend `src/transcript.ts`**

```ts
export interface TranscriptData {
  model: string;
  task: string;
  status: string;
  messages: Message[];
  usage: Usage[];
  /** Test gate output, when a write run had one. Envelope carries only the verdict. */
  test_output?: string;
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun test tests/envelope.test.ts`
Expected: PASS. Then `bun test` — whole suite green (the CLI's compact-envelope test mentions 600 only in a comment; update that comment to say `MAX_ENVELOPE_CHARS`).

- [ ] **Step 6: Typecheck, then commit**

Run: `bun run typecheck` — silent, exit 0.

```bash
git add src/envelope.ts src/transcript.ts tests/envelope.test.ts tests/cli.test.ts
git commit -m "feat: write-outcome envelope fields, 1200-char bound

files_changed (entry-capped with an explicit remainder), diffstat, the test
verdict, and the kept worktree's path. The bound rises from 600: measured
against a real 20-item citation list, 600 returned 6 items and sent the
caller to the transcript — the exact cost the envelope exists to avoid.
Test output goes to the transcript; the envelope carries only the verdict."
```

---

### Task 8: CLI wiring, end to end

The worktree lifecycle around the loop: create at HEAD, confine the loop to it, collect the diff, run the gate, report — and never lose the envelope to a post-loop failure. Exit code 0 now additionally requires the gate to pass.

**Files:**
- Modify: `src/loop.ts` (one exported constant)
- Modify: `src/cli.ts`
- Test: `tests/cli-write.test.ts` (create)

**Interfaces:**
- Consumes: everything Tasks 1–7 produced: `hasWriteTools`, `run.worktree`/`run.testCmd`/`run.testTimeoutMs`, `assertGitRepo`/`createWorktree`/`collectChanges`/`removeWorktree`, `runTestGate`, `WriteOutcome`, `TranscriptData.test_output`.
- Produces: `WRITE_SYSTEM_PROMPT_SUFFIX` from `src/loop.ts`; the CLI behavior Phase B's `executeRun` extraction (Task 10) lifts verbatim.

- [ ] **Step 1: Write the failing tests**

Create `tests/cli-write.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test tests/cli-write.test.ts`
Expected: FAIL — the CLI knows nothing of worktrees; `env.files_changed` is undefined, the non-git-root case exits 0 instead of 1, and the suffix test finds no such text.

- [ ] **Step 3: Export the write suffix from `src/loop.ts`**

Directly below `DEFAULT_SYSTEM_PROMPT`:

```ts
// Appended only when the profile has write tools — read-only runs must not
// pay for it every turn (prompt economy).
export const WRITE_SYSTEM_PROMPT_SUFFIX =
  "\nread_file a file before editing it. Make the smallest change that satisfies the task.";
```

- [ ] **Step 4: Rewire `src/cli.ts`**

Extend the imports:

```ts
import { hasWriteTools, resolveTools } from "./tools/registry";
import { DEFAULT_SYSTEM_PROMPT, WRITE_SYSTEM_PROMPT_SUFFIX, runLoop } from "./loop";
import { buildEnvelope, type WriteOutcome } from "./envelope";
import { assertGitRepo, collectChanges, createWorktree, removeWorktree } from "./worktree";
import { runTestGate } from "./testgate";
```

Then replace the block that currently runs from `const tools = resolveTools(run.tools);` through the final `return result.status === "ok" ? 0 : 2;` with:

```ts
  // Resolved on its own statement, not inlined into the runLoop call below:
  // an unknown tool name in the profile must fail before any backend call
  // is made, and that ordering should hold because it's stated, not because
  // of where it happens to sit in an object literal's argument evaluation.
  const tools = resolveTools(run.tools);
  const writes = hasWriteTools(run.tools);

  // The deadline clock starts before worktree creation — setup time is
  // inside the caller's budget, not in addition to it.
  const started = Date.now();

  // Everything from here on is a can't-start check or the run itself; a
  // worktree failure here (not a repo, git missing) is exit 1 with nothing
  // on stdout, same as a bad profile.
  let loopRoot = root;
  let worktreeDir: string | undefined;
  if (run.worktree) {
    await assertGitRepo(root);
    worktreeDir = join(
      process.env["TMPDIR"] ?? "/tmp", `subagents-wt-${Date.now()}`);
    await createWorktree(root, worktreeDir);
    loopRoot = worktreeDir;
  }

  const result = await runLoop({
    backend: new OpenAIBackend(run.baseUrl, process.env["SUBAGENTS_API_KEY"]),
    model: run.model,
    tools,
    task: values.task!,
    maxTurns: run.maxTurns,
    maxTokens: run.maxTokens,
    sampling: run.sampling,
    timeoutMs: run.timeoutMs,
    root: loopRoot,
    ...(writes
      ? { systemPrompt: DEFAULT_SYSTEM_PROMPT + WRITE_SYSTEM_PROMPT_SUFFIX }
      : {}),
    ...(deadlineSecs === undefined
      ? {}
      : { deadlineAt: started + deadlineSecs * 1000 }),
    ...(values.verbose
      ? {
          onTurn: (turn: number, secs: number, names: string[]) =>
            process.stderr.write(
              `  turn ${turn}: ${secs.toFixed(1)}s tools=[${names.join(", ")}]\n`),
        }
      : {}),
  });

  // Post-loop inspection is a side channel, like the transcript below: its
  // failure must degrade a field honestly, never cost the caller the
  // envelope the run already earned.
  let writeOutcome: WriteOutcome | undefined;
  let testOutput: string | undefined;
  if (worktreeDir) {
    try {
      const changes = await collectChanges(worktreeDir);
      if (changes.files.length === 0) {
        await removeWorktree(root, worktreeDir);
      } else {
        writeOutcome = {
          files: changes.files,
          diffstat: changes.diffstat,
          worktree: worktreeDir,
        };
        if (run.testCmd) {
          const gate = await runTestGate(run.testCmd, worktreeDir, run.testTimeoutMs);
          writeOutcome.test = { ran: true, passed: gate.passed, cmd: run.testCmd };
          testOutput = gate.timedOut
            ? `[test gate timed out after ${run.testTimeoutMs}ms]\n${gate.output}`
            : gate.output;
        }
      }
    } catch (e) {
      writeOutcome = {
        files: [],
        diffstat:
          `(FAILED to inspect worktree: ${e instanceof Error ? e.message : String(e)})`,
        worktree: worktreeDir,
      };
    }
  }

  // The transcript is a side channel, not the envelope's own promise to the
  // caller: an I/O failure writing it (a full disk, an unwritable path)
  // must not take down the run that already produced a valid result. If it
  // fails, say so honestly in the field that would otherwise silently point
  // at a path with nothing in it.
  let transcriptField = transcriptPath;
  try {
    await writeTranscript(transcriptPath, {
      model: run.model,
      task: values.task!,
      status: result.status,
      messages: result.messages,
      usage: result.usage,
      ...(testOutput !== undefined ? { test_output: testOutput } : {}),
    });
  } catch (e) {
    transcriptField =
      `${transcriptPath} (FAILED to write: ${e instanceof Error ? e.message : String(e)})`;
  }

  const envelope = buildEnvelope(result, {
    wallSecs: (Date.now() - started) / 1000,
    transcript: transcriptField,
    contextLimit: null,
    ...(writeOutcome ? { writes: writeOutcome } : {}),
  });
  // Compact, not pretty-printed: buildEnvelope's size bound is measured
  // against JSON.stringify(envelope) with no spacing, so stdout must emit
  // exactly that form rather than a differently-sized pretty one.
  process.stdout.write(`${JSON.stringify(envelope)}\n`);

  // 0 now means "nothing needs your attention": the loop completed AND the
  // gate (when one ran) passed. A failed gate is exit 2 with an honest
  // envelope — same class as max_turns: ran, but read before trusting.
  const gateFailed = writeOutcome?.test !== undefined && !writeOutcome.test.passed;
  return result.status === "ok" && !gateFailed ? 0 : 2;
```

Finally, update `USAGE`: replace the `Exit codes:` block with

```text
Write profiles run in a git worktree detached at HEAD — uncommitted changes
in --root are invisible to the delegate. When the delegate changed files the
worktree is kept and the envelope reports its path, files_changed, diffstat,
and the test gate's verdict.

Exit codes:
  0  completed: status "ok" and the test gate (if configured) passed.
  2  ran, but status is not "ok" or the test gate failed — an envelope is
     still on stdout; read it before treating this as failure.
  1  never started — nothing on stdout, the error is on stderr.
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun test tests/cli-write.test.ts`
Expected: PASS, 6 tests. Then `bun test` — whole suite green (read-only CLI behavior is unchanged; `digest` has no write tools, so no worktree and no suffix).

- [ ] **Step 6: Typecheck, then commit**

Run: `bun run typecheck` — silent, exit 0.

```bash
git add src/loop.ts src/cli.ts tests/cli-write.test.ts
git commit -m "feat: write runs end to end — worktree lifecycle, test gate, exit contract

The loop runs confined to a worktree detached at HEAD; changes are collected
from the throwaway index; the gate runs when configured; the worktree is
kept exactly when there is a diff to inspect. Post-loop inspection failures
degrade the diffstat field honestly instead of costing the envelope. Exit 0
now also requires the gate to pass — 'nothing needs your attention'."
```

---

### Task 9: Documentation sweep — Phase A ships

Every user-facing surface currently says, deliberately, that writes don't exist. Once Task 8 lands they do; each surface must move in the same commit. There is no code in this task — each step names the file and gives the exact replacement text.

**Files:**
- Modify: `README.md`
- Modify: `docs/design.md`
- Modify: `skills/subagents/SKILL.md`
- Modify: `.claude-plugin/plugin.json`
- Modify: `.claude-plugin/marketplace.json`
- Modify: `package.json`
- Modify: `subagents.example.yaml`

**Interfaces:** none — prose only. Verified against the code by the checks in each step.

- [ ] **Step 1: `README.md`**

In "What ships today", append to the bullet list:

```markdown
- Write support: `edit_file` (exact-substring replace, unique match, read-before-edit)
  and `write_file` (create, or overwrite-after-read), confined to a git worktree
  detached at HEAD — the delegate never touches your working tree, and sees your
  last commit, not uncommitted changes
- A test gate: a write profile's `test_cmd` runs in the worktree after the loop;
  the envelope reports the verdict, and a failed gate keeps the worktree so the
  diff can still be inspected
```

In "What's planned, not built", delete these two bullets:

```markdown
- `edit_file` / `write_file`, `bash`, and an MCP client for external tools
- Git worktree isolation and a test gate for write profiles
```

so the list reads:

```markdown
- `bash` as a model-callable tool (the harness-run test gate exists; arbitrary
  commands do not)
- An MCP client for external tools
- The LM Studio adapter (capability probe, `context.limit`/`context.pressure`
  — both are `null` today because nothing populates them yet)
- Batch scheduling across multiple jobs and models
- The agentic-loop benchmark harness
```

Update the status blockquote near the top to:

```markdown
> **Status: read-only loop and worktree-confined writes ship; bash, MCP, and
> batch are planned.** `subagents run` works today against any OpenAI-compatible
> endpoint, verified against a live model. See [What ships today](#what-ships-today)
> below for the exact boundary.
```

- [ ] **Step 2: `docs/design.md`**

1. Update the `Status:` paragraph to include write tools, the worktree, and the test gate as shipped; batch/LM Studio/MCP/bench remain designed-not-built.
2. In the **Safety** section, replace the `- **Test gate** — configured command runs after edits. Failure reverts and the envelope reports it.` bullet with:

```markdown
- **Test gate** — the profile's `test_cmd` runs in the worktree after edits.
  Failure is *reported, not reverted*: with worktree isolation the diff is the
  deliverable, and a failed-but-close diff is salvageable by the orchestrator.
  (Earlier drafts said "revert"; that predates worktree-by-default.)
```

3. In the **Envelope** section's "today's envelope is a subset" paragraph, update the field list: `files_changed`, `diffstat`, `test`, and `worktree` now exist for write runs; `tools_omitted` still doesn't (no MCP client); `context.limit`/`pressure` still `null`.
4. In the **Tool contract** table, the `edit_file` and `write_file` rows already describe what shipped — verify their wording against `src/tools/edit.ts`/`write.ts` (unique-match, read-before-write) and adjust only if they disagree. The `bash` row gains "(planned)".

- [ ] **Step 3: `skills/subagents/SKILL.md`**

1. Frontmatter `description`: append `, delegated small edits with a test gate` after `enumerating patterns repo-wide`.
2. "What ships today" adds `edit_file` and `write_file` to the tool list (verified against `src/tools/registry.ts`: six tools total). "What doesn't" drops editing, keeps: bash, MCP tools, batch scheduling, benchmark harness.
3. Add a section after **Invocation**:

```markdown
## Write profiles

A profile with `edit_file`/`write_file` runs in a **git worktree detached at
HEAD**. Three consequences you must plan around:

- **The delegate sees your last commit, not your working tree.** Commit or
  stash before delegating an edit, or the delegate edits stale code.
- **The edit lands in the worktree**, whose path the envelope reports as
  `worktree`. Inspect `git -C <worktree> diff HEAD` (everything is staged),
  then apply what you accept — e.g. `git -C <worktree> diff HEAD | git apply`.
  Nothing touches your tree until you do this.
- **Budget for the test gate.** `test_cmd` runs after the loop, inside the
  worktree, up to `test_timeout_ms` (default 120s). Your shell timeout must
  cover `--deadline-secs` *plus* the gate.

Exit 0 now means the loop completed **and** the gate (if configured) passed.
A failed gate exits 2 with `test.passed: false` — the worktree is kept, so a
failed-but-close diff is still yours to salvage or discard.
```

4. In "Reading the envelope", extend the example JSON with `"files_changed": ["src/rate-limit.ts"], "diffstat": "1 file changed, 1 insertion(+), 1 deletion(-)", "test": {"ran": true, "passed": true, "cmd": "bun test"}, "worktree": "/tmp/subagents-wt-…"` and add one check bullet:

```markdown
- **`test.passed: false`** — the delegate's diff breaks the configured test
  command. The worktree is kept; read the transcript's `test_output` before
  deciding whether to salvage or discard.
```

5. In "Trust rules", add:

```markdown
- **Never apply a diff you haven't read.** The envelope's `files_changed` says
  where the delegate edited, not that the edits are right. Read the worktree
  diff; the test gate narrows the risk but a passing gate is not review.
```

- [ ] **Step 4: Manifests and `package.json`**

- `.claude-plugin/plugin.json` `description`: `"Delegate scoped code investigation and small worktree-confined edits to any OpenAI-compatible model, for a fixed small context cost"`.
- `.claude-plugin/marketplace.json`: top-level `description` same as above; the plugin entry's `description` becomes: `"Run agentic subagents on any OpenAI-compatible endpoint (LM Studio, Ollama, vLLM, llama.cpp, LiteLLM). The delegate reads, greps, globs, and edits files in a detached git worktree with a test gate; the orchestrator gets back a small JSON envelope instead of the whole transcript. Bash, MCP tools, and batch scheduling are planned, not shipped."`
- `package.json` `description`: `"Delegate scoped coding tasks to any OpenAI-compatible model"`.

- [ ] **Step 5: `subagents.example.yaml`**

Append to the `profiles:` block:

```yaml
  # Write profile: runs in a git worktree detached at HEAD; the envelope
  # reports the worktree path and diffstat. test_cmd runs there after the
  # loop — a failed gate keeps the worktree and exits 2.
  fix: { tools: [read_file, glob, grep, edit_file, write_file], tier: strong, test_cmd: "bun test" }
```

And to the `defaults:` block:

```yaml
  test_timeout_ms: 120000
```

- [ ] **Step 6: Verify and commit**

Checks: every tool named in any doc exists in `src/tools/registry.ts` (six); the SKILL.md exit-code text matches `USAGE` in `src/cli.ts`; no surface still claims writes are unimplemented — read the "planned" lists in README.md, SKILL.md's "What doesn't", and both manifest descriptions, and confirm none of them lists `edit_file`/`write_file`/worktree/test-gate as future work (`bash`, MCP, batch, benchmark are the correct remaining entries at this point).

```bash
git add README.md docs/design.md skills/subagents/SKILL.md .claude-plugin/plugin.json .claude-plugin/marketplace.json package.json subagents.example.yaml
git commit -m "docs: write support is shipped — say so on every surface

README, design doc, skill, manifests, and the example config all described
a read-only tool, deliberately. Phase A makes that description false, so
every surface moves in one commit. The skill gains the three write-profile
caveats an orchestrator must plan around: the delegate sees HEAD, the diff
lives in the kept worktree, and the shell timeout must cover the test gate."
```

---

# Phase B — batch scheduling (Tasks 10–16)

### Task 10: Extract `executeRun`

Behavior-preserving refactor: the single-run path moves from `cli.ts` into `src/run.ts` so `batch` can reuse it verbatim. The existing CLI suites staying green *is* the test — no new behavior, no new tests.

**Files:**
- Create: `src/run.ts`
- Modify: `src/cli.ts`

**Interfaces:**
- Consumes: everything Task 8 wired.
- Produces: `interface RunRequest { run: ResolvedRun; task: string; root: string; transcriptPath: string; deadlineAt?: number; apiKey?: string; onTurn?: LoopOptions["onTurn"] }`, `interface RunOutcome { envelope: Envelope; clean: boolean }`, `executeRun(req: RunRequest): Promise<RunOutcome>`. Tasks 13 and 16 call it once per job.

- [ ] **Step 1: Create `src/run.ts`**

The body is Task 8's post-parse block, moved verbatim except: `values.task!` → `req.task`, `root` → `req.root`, `run` → `req.run`, `transcriptPath` → `req.transcriptPath`, the deadline spread keys off `req.deadlineAt`, `onTurn` comes from `req.onTurn`, the envelope is returned instead of printed, and can't-start failures still throw (the caller maps them to exit 1).

```ts
import { join } from "node:path";
import type { ResolvedRun } from "./config";
import type { LoopOptions } from "./loop";
import { OpenAIBackend } from "./backends/base";
import { hasWriteTools, resolveTools } from "./tools/registry";
import { DEFAULT_SYSTEM_PROMPT, WRITE_SYSTEM_PROMPT_SUFFIX, runLoop } from "./loop";
import { buildEnvelope, type Envelope, type WriteOutcome } from "./envelope";
import { writeTranscript } from "./transcript";
import { assertGitRepo, collectChanges, createWorktree, removeWorktree } from "./worktree";
import { runTestGate } from "./testgate";

export interface RunRequest {
  run: ResolvedRun;
  task: string;
  /** Absolute, existence-checked by the caller. */
  root: string;
  transcriptPath: string;
  deadlineAt?: number;
  apiKey?: string;
  onTurn?: LoopOptions["onTurn"];
}

export interface RunOutcome {
  envelope: Envelope;
  /** True only when the loop finished ok AND the test gate (if any) passed. */
  clean: boolean;
}

/**
 * One complete delegated run: worktree lifecycle, loop, gate, transcript,
 * envelope. Throws only for can't-start conditions (bad tool name, not a
 * git repo); once the loop has run, every failure degrades a field instead.
 */
export async function executeRun(req: RunRequest): Promise<RunOutcome> {
  const { run } = req;
  const tools = resolveTools(run.tools);
  const writes = hasWriteTools(run.tools);

  const started = Date.now();

  let loopRoot = req.root;
  let worktreeDir: string | undefined;
  if (run.worktree) {
    await assertGitRepo(req.root);
    worktreeDir = join(
      process.env["TMPDIR"] ?? "/tmp", `subagents-wt-${started}-${Math.floor(Math.random() * 1e6)}`);
    await createWorktree(req.root, worktreeDir);
    loopRoot = worktreeDir;
  }

  const result = await runLoop({
    backend: new OpenAIBackend(run.baseUrl, req.apiKey),
    model: run.model,
    tools,
    task: req.task,
    maxTurns: run.maxTurns,
    maxTokens: run.maxTokens,
    sampling: run.sampling,
    timeoutMs: run.timeoutMs,
    root: loopRoot,
    ...(writes
      ? { systemPrompt: DEFAULT_SYSTEM_PROMPT + WRITE_SYSTEM_PROMPT_SUFFIX }
      : {}),
    ...(req.deadlineAt === undefined ? {} : { deadlineAt: req.deadlineAt }),
    ...(req.onTurn ? { onTurn: req.onTurn } : {}),
  });

  let writeOutcome: WriteOutcome | undefined;
  let testOutput: string | undefined;
  if (worktreeDir) {
    try {
      const changes = await collectChanges(worktreeDir);
      if (changes.files.length === 0) {
        await removeWorktree(req.root, worktreeDir);
      } else {
        writeOutcome = {
          files: changes.files,
          diffstat: changes.diffstat,
          worktree: worktreeDir,
        };
        if (run.testCmd) {
          const gate = await runTestGate(run.testCmd, worktreeDir, run.testTimeoutMs);
          writeOutcome.test = { ran: true, passed: gate.passed, cmd: run.testCmd };
          testOutput = gate.timedOut
            ? `[test gate timed out after ${run.testTimeoutMs}ms]\n${gate.output}`
            : gate.output;
        }
      }
    } catch (e) {
      writeOutcome = {
        files: [],
        diffstat:
          `(FAILED to inspect worktree: ${e instanceof Error ? e.message : String(e)})`,
        worktree: worktreeDir,
      };
    }
  }

  let transcriptField = req.transcriptPath;
  try {
    await writeTranscript(req.transcriptPath, {
      model: run.model,
      task: req.task,
      status: result.status,
      messages: result.messages,
      usage: result.usage,
      ...(testOutput !== undefined ? { test_output: testOutput } : {}),
    });
  } catch (e) {
    transcriptField =
      `${req.transcriptPath} (FAILED to write: ${e instanceof Error ? e.message : String(e)})`;
  }

  const envelope = buildEnvelope(result, {
    wallSecs: (Date.now() - started) / 1000,
    transcript: transcriptField,
    contextLimit: null,
    ...(writeOutcome ? { writes: writeOutcome } : {}),
  });

  const gateFailed = writeOutcome?.test !== undefined && !writeOutcome.test.passed;
  return { envelope, clean: result.status === "ok" && !gateFailed };
}
```

(One deliberate change while moving: the worktree directory name gains a random suffix. Two jobs in one batch can start inside the same millisecond, and `Date.now()` alone would collide.)

- [ ] **Step 2: Slim `src/cli.ts`**

In `main`, replace everything from `const tools = resolveTools(run.tools);` through the final `return` with:

```ts
  const started = Date.now();
  const { envelope, clean } = await executeRun({
    run,
    task: values.task!,
    root,
    transcriptPath,
    ...(deadlineSecs === undefined
      ? {}
      : { deadlineAt: started + deadlineSecs * 1000 }),
    ...(process.env["SUBAGENTS_API_KEY"]
      ? { apiKey: process.env["SUBAGENTS_API_KEY"] }
      : {}),
    ...(values.verbose
      ? {
          onTurn: (turn: number, secs: number, names: string[]) =>
            process.stderr.write(
              `  turn ${turn}: ${secs.toFixed(1)}s tools=[${names.join(", ")}]\n`),
        }
      : {}),
  });

  // Compact, not pretty-printed: buildEnvelope's size bound is measured
  // against JSON.stringify(envelope) with no spacing, so stdout must emit
  // exactly that form rather than a differently-sized pretty one.
  process.stdout.write(`${JSON.stringify(envelope)}\n`);
  return clean ? 0 : 2;
```

Drop the imports `cli.ts` no longer uses (`OpenAIBackend`, `resolveTools`, `hasWriteTools`, `runLoop` and the prompt constants, `buildEnvelope`, `writeTranscript`, worktree and testgate functions) and add `import { executeRun } from "./run";`.

- [ ] **Step 3: Verify the refactor changed nothing observable**

Run: `bun test && bun run typecheck`
Expected: the whole suite passes untouched — `tests/cli.test.ts` and `tests/cli-write.test.ts` exercise every path through the subprocess boundary, which is exactly what makes them the refactor's safety net.

- [ ] **Step 4: Commit**

```bash
git add src/run.ts src/cli.ts
git commit -m "refactor: extract executeRun for batch to share

Pure move of the single-run path — worktree, loop, gate, transcript,
envelope — behind a function batch can call once per job. The CLI subprocess
suites are the proof nothing observable changed. Worktree names gain a
random suffix: two batch jobs can start in the same millisecond."
```

---

### Task 11: Jobs file and provider concurrency config

`jobs.yaml` parsing with fail-fast validation — every job resolves against config *before* any run, because one typo'd profile discovered at job 29 of 30 wastes the 28 before it — plus `max_in_flight` on providers and the (provider, model) identity Phase B groups by.

**Files:**
- Modify: `src/config.ts`
- Create: `src/batch/jobs.ts`
- Test: `tests/config.test.ts` (append)
- Test: `tests/batch/jobs.test.ts` (create)

**Interfaces:**
- Consumes: `Config`, `resolveProfile`, `ResolvedRun` from `src/config.ts`.
- Produces: `ProviderConfig.max_in_flight?: number`, `ResolvedRun.provider: string`, `ResolvedRun.maxInFlight: number` (default 2); `interface JobSpec { id: string; profile: string; task: string; root?: string; tier?: string }`, `interface ResolvedJob { id: string; spec: JobSpec; run: ResolvedRun; root: string }`, `parseJobs(text: string): JobSpec[]`, `resolveJobs(cfg: Config, specs: JobSpec[], defaultRoot: string): ResolvedJob[]`. Task 12 groups on `run.provider`/`run.model` and fans out under `run.maxInFlight`; Task 16 wires the CLI.

- [ ] **Step 1: Write the failing tests**

Append to `tests/config.test.ts`:

```ts
describe("provider concurrency", () => {
  it("resolves max_in_flight with a conservative default of 2", () => {
    const r = resolveProfile(parseConfig(YAML_OK), "digest");
    expect(r.maxInFlight).toBe(2);
    expect(r.provider).toBe("local");
  });

  it("honours a measured max_in_flight", () => {
    const yaml = YAML_OK.replace(
      'local: { base_url: "http://127.0.0.1:1234/v1", kind: lmstudio }',
      'local: { base_url: "http://127.0.0.1:1234/v1", kind: lmstudio, max_in_flight: 4 }',
    );
    expect(resolveProfile(parseConfig(yaml), "digest").maxInFlight).toBe(4);
  });

  it("rejects a non-positive or fractional max_in_flight", () => {
    const yaml = YAML_OK.replace(
      'local: { base_url: "http://127.0.0.1:1234/v1", kind: lmstudio }',
      'local: { base_url: "http://127.0.0.1:1234/v1", kind: lmstudio, max_in_flight: 0 }',
    );
    expect(() => resolveProfile(parseConfig(yaml), "digest")).toThrow(/max_in_flight/);
  });
});
```

Create `tests/batch/jobs.test.ts`:

```ts
import { describe, it, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig } from "../../src/config";
import { parseJobs, resolveJobs } from "../../src/batch/jobs";

const CFG = parseConfig(`
providers:
  local: { base_url: "http://127.0.0.1:1234/v1" }
tiers:
  cheap:  { provider: local, model: "small" }
  strong: { provider: local, model: "big" }
profiles:
  digest: { tools: [read_file, grep], tier: cheap }
`);

const JOBS_OK = `
jobs:
  - { profile: digest, task: "count the routes" }
  - { id: logs, profile: digest, task: "digest the log", tier: strong }
`;

describe("parseJobs", () => {
  it("parses jobs and assigns positional ids where omitted", () => {
    const specs = parseJobs(JOBS_OK);
    expect(specs.map((s) => s.id)).toEqual(["j1", "logs"]);
    expect(specs[1]!.tier).toBe("strong");
  });

  it("rejects a file without a non-empty jobs list", () => {
    expect(() => parseJobs("jobs: []\n")).toThrow(/non-empty 'jobs' list/);
    expect(() => parseJobs("- a\n")).toThrow(/non-empty 'jobs' list/);
  });

  it("rejects a job missing profile or task, naming its position", () => {
    expect(() => parseJobs("jobs:\n  - { task: x }\n")).toThrow(/jobs\[0\].*profile/);
    expect(() => parseJobs("jobs:\n  - { profile: digest }\n")).toThrow(/jobs\[0\].*task/);
  });

  it("rejects duplicate ids", () => {
    expect(() => parseJobs(
      "jobs:\n  - { id: a, profile: p, task: t }\n  - { id: a, profile: p, task: t }\n",
    )).toThrow(/duplicate id 'a'/);
  });
});

describe("resolveJobs", () => {
  it("resolves every job up front, applying per-job tier overrides", () => {
    const jobs = resolveJobs(CFG, parseJobs(JOBS_OK), process.cwd());
    expect(jobs[0]!.run.model).toBe("small");
    expect(jobs[1]!.run.model).toBe("big");
    expect(jobs[0]!.root).toBe(process.cwd());
  });

  it("fails fast, naming the job, before anything runs", () => {
    const bad = parseJobs("jobs:\n  - { id: oops, profile: ghost, task: t }\n");
    expect(() => resolveJobs(CFG, bad, process.cwd())).toThrow(/job 'oops'.*ghost/s);
  });

  it("rejects a job root that does not exist", () => {
    const gone = join(mkdtempSync(join(tmpdir(), "subagents-jobs-")), "nope");
    const specs = parseJobs(`jobs:\n  - { id: r, profile: digest, task: t, root: "${gone}" }\n`);
    try {
      expect(() => resolveJobs(CFG, specs, process.cwd())).toThrow(/job 'r'.*does not exist/s);
    } finally {
      rmSync(join(gone, ".."), { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test tests/config.test.ts tests/batch/jobs.test.ts`
Expected: FAIL — `maxInFlight`/`provider` missing from `ResolvedRun`; cannot resolve `../../src/batch/jobs`.

- [ ] **Step 3: Extend `src/config.ts`**

```ts
export interface ProviderConfig {
  base_url: string;
  kind?: "openai" | "lmstudio";
  /** Measured concurrency ceiling for this host. Default 2 — conservative. */
  max_in_flight?: number;
}
```

`ResolvedRun` gains:

```ts
  /** The tier's provider name — batch groups jobs by (provider, model). */
  provider: string;
  maxInFlight: number;
```

In `resolveProfile`, after the `provider` lookup:

```ts
  const maxInFlight = provider.max_in_flight ?? 2;
  if (!Number.isInteger(maxInFlight) || maxInFlight <= 0) {
    throw new Error(
      `provider '${tier.provider}': max_in_flight must be a positive integer, ` +
        `got ${JSON.stringify(provider.max_in_flight)}`,
    );
  }
```

and the returned object gains:

```ts
    provider: tier.provider,
    maxInFlight,
```

- [ ] **Step 4: Create `src/batch/jobs.ts`**

```ts
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { Config, ResolvedRun } from "../config";
import { resolveProfile } from "../config";

export interface JobSpec {
  id: string;
  profile: string;
  task: string;
  root?: string;
  tier?: string;
}

export interface ResolvedJob {
  id: string;
  spec: JobSpec;
  run: ResolvedRun;
  /** Absolute, existence-checked. */
  root: string;
}

export function parseJobs(text: string): JobSpec[] {
  const raw = Bun.YAML.parse(text) as unknown;
  const jobs = raw !== null && typeof raw === "object" && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)["jobs"]
    : undefined;
  if (!Array.isArray(jobs) || jobs.length === 0) {
    throw new Error("jobs file: top level must be a mapping with a non-empty 'jobs' list");
  }
  const seen = new Set<string>();
  return jobs.map((j, i) => {
    if (j === null || typeof j !== "object" || Array.isArray(j)) {
      throw new Error(`jobs[${i}]: must be a mapping`);
    }
    const job = j as Record<string, unknown>;
    if (typeof job["profile"] !== "string" || !job["profile"]) {
      throw new Error(`jobs[${i}]: missing 'profile'`);
    }
    if (typeof job["task"] !== "string" || !job["task"]) {
      throw new Error(`jobs[${i}]: missing 'task'`);
    }
    const id = job["id"] === undefined ? `j${i + 1}` : String(job["id"]);
    if (seen.has(id)) throw new Error(`jobs: duplicate id '${id}'`);
    seen.add(id);
    return {
      id,
      profile: job["profile"],
      task: job["task"],
      ...(typeof job["root"] === "string" ? { root: job["root"] } : {}),
      ...(typeof job["tier"] === "string" ? { tier: job["tier"] } : {}),
    };
  });
}

/**
 * Resolve every job before any runs. One bad job fails the whole batch up
 * front — a typo'd profile discovered at job 29 of 30 wastes the 28 before it.
 */
export function resolveJobs(cfg: Config, specs: JobSpec[], defaultRoot: string): ResolvedJob[] {
  return specs.map((spec) => {
    let run: ResolvedRun;
    try {
      run = resolveProfile(cfg, spec.profile, spec.tier !== undefined ? { tier: spec.tier } : {});
    } catch (e) {
      throw new Error(`job '${spec.id}': ${e instanceof Error ? e.message : String(e)}`);
    }
    const root = resolve(spec.root ?? defaultRoot);
    if (!existsSync(root)) {
      throw new Error(`job '${spec.id}': root does not exist: ${root}`);
    }
    return { id: spec.id, spec, run, root };
  });
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun test tests/config.test.ts tests/batch/jobs.test.ts`
Expected: PASS. Then `bun test` — whole suite green.

- [ ] **Step 6: Typecheck, then commit**

Run: `bun run typecheck` — silent, exit 0.

```bash
git add src/config.ts src/batch/jobs.ts tests/config.test.ts tests/batch/jobs.test.ts
git commit -m "feat: jobs file with fail-fast resolution, provider max_in_flight

Every job resolves against config before anything runs; errors name the job.
max_in_flight defaults to 2 — measured to capture most of the available gain
on an unknown host with little risk — and known hosts declare what they
measured. ResolvedRun now names its provider: batch groups by (provider,
model) so each model loads exactly once."
```

---

### Task 12: Scheduler — model grouping and bounded fan-out

The design's scheduling invariant, encoded: jobs group by (provider, model), groups run sequentially so each model loads exactly once, and within a group at most `max_in_flight` jobs run at once. A failing job is a result, not a crash. Deadline gating arrives in Task 13.

**Files:**
- Create: `src/batch/scheduler.ts`
- Test: `tests/batch/scheduler.test.ts`

**Interfaces:**
- Consumes: `ResolvedJob` from `src/batch/jobs.ts`; `Envelope` from `src/envelope.ts`.
- Produces: `interface JobResult { id: string; envelope: Envelope | null; error?: string; queuedAt: number; startedAt: number; finishedAt: number }`, `interface BatchState { total: number; done: string[]; running: string[]; pending: string[]; not_run: string[] }`, `interface ScheduleOptions { jobs: ResolvedJob[]; runJob(job: ResolvedJob): Promise<Envelope>; onUpdate?(state: BatchState): void }`, `interface ScheduleResult { results: JobResult[]; notRun: string[] }`, `schedule(o: ScheduleOptions): Promise<ScheduleResult>`. Task 13 adds `deadlineAt?`/`reserveMs?` to `ScheduleOptions`; Task 15 turns timings into evidence; Task 16 injects `executeRun` as `runJob`.

- [ ] **Step 1: Write the failing tests**

Create `tests/batch/scheduler.test.ts`. The fake-job helpers at the top are shared with Task 13's additions to this file:

```ts
import { describe, it, expect } from "bun:test";
import type { Envelope } from "../../src/envelope";
import type { ResolvedJob } from "../../src/batch/jobs";
import { schedule, type BatchState } from "../../src/batch/scheduler";

/** A ResolvedJob with just the fields the scheduler reads. */
function job(id: string, model: string, maxInFlight = 1): ResolvedJob {
  return {
    id,
    spec: { id, profile: "p", task: "t" },
    root: "/",
    run: {
      baseUrl: "http://x/v1", kind: "openai", model, sampling: {}, tools: [],
      maxTurns: 1, maxTokens: 1, timeoutMs: 1000, worktree: false,
      testTimeoutMs: 1000, provider: "local", maxInFlight,
    },
  };
}

function envelope(id: string): Envelope {
  return {
    status: "ok", summary: id, turns: 1, wall_secs: 0.1,
    context: { peak_prompt_tokens: 1, limit: null, pressure: null },
    truncations: 0, local_tokens: 2, transcript: `/t/${id}.json`,
  };
}

describe("schedule", () => {
  it("runs groups sequentially by (provider, model), in first-seen order", async () => {
    const started: string[] = [];
    const { results } = await schedule({
      jobs: [job("a1", "m1"), job("b1", "m2"), job("a2", "m1")],
      runJob: async (j) => {
        started.push(j.id);
        await Bun.sleep(10);
        return envelope(j.id);
      },
    });
    // m1's group (a1, a2) drains before m2's begins — the model loads once.
    expect(started).toEqual(["a1", "a2", "b1"]);
    expect(results).toHaveLength(3);
  });

  it("caps in-group concurrency at max_in_flight", async () => {
    let inFlight = 0;
    let peak = 0;
    await schedule({
      jobs: [job("a", "m", 2), job("b", "m", 2), job("c", "m", 2), job("d", "m", 2)],
      runJob: async (j) => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await Bun.sleep(20);
        inFlight--;
        return envelope(j.id);
      },
    });
    expect(peak).toBe(2);
  });

  it("turns a throwing job into a result, not a crash", async () => {
    const { results } = await schedule({
      jobs: [job("ok1", "m"), job("boom", "m"), job("ok2", "m")],
      runJob: async (j) => {
        if (j.id === "boom") throw new Error("connection refused");
        return envelope(j.id);
      },
    });
    const boom = results.find((r) => r.id === "boom")!;
    expect(boom.envelope).toBeNull();
    expect(boom.error).toContain("connection refused");
    expect(results.filter((r) => r.envelope !== null)).toHaveLength(2);
  });

  it("records queued/started/finished timestamps in order", async () => {
    const { results } = await schedule({
      jobs: [job("a", "m")],
      runJob: async () => {
        await Bun.sleep(15);
        return envelope("a");
      },
    });
    const r = results[0]!;
    expect(r.queuedAt).toBeLessThanOrEqual(r.startedAt);
    expect(r.startedAt).toBeLessThan(r.finishedAt);
    expect(r.finishedAt - r.startedAt).toBeGreaterThanOrEqual(10);
  });

  it("reports state transitions through onUpdate", async () => {
    const states: BatchState[] = [];
    await schedule({
      jobs: [job("a", "m"), job("b", "m")],
      runJob: async (j) => {
        await Bun.sleep(5);
        return envelope(j.id);
      },
      onUpdate: (s) => states.push(structuredClone(s)),
    });
    expect(states.some((s) => s.running.includes("a") && s.pending.includes("b"))).toBe(true);
    const last = states[states.length - 1]!;
    expect(last.done.sort()).toEqual(["a", "b"]);
    expect(last.running).toEqual([]);
    expect(last.pending).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test tests/batch/scheduler.test.ts`
Expected: FAIL — cannot resolve `../../src/batch/scheduler`.

- [ ] **Step 3: Create `src/batch/scheduler.ts`**

```ts
import type { Envelope } from "../envelope";
import type { ResolvedJob } from "./jobs";

export interface JobResult {
  id: string;
  /** null when runJob threw; `error` says why. */
  envelope: Envelope | null;
  error?: string;
  queuedAt: number;
  startedAt: number;
  finishedAt: number;
}

export interface BatchState {
  total: number;
  done: string[];
  running: string[];
  pending: string[];
  not_run: string[];
}

export interface ScheduleOptions {
  jobs: ResolvedJob[];
  runJob(job: ResolvedJob): Promise<Envelope>;
  /**
   * Advisory progress callback (drives the --progress file). Not awaited:
   * a slow observer must not slow the batch, and a torn read of the
   * progress file costs the poller one re-poll, not correctness.
   */
  onUpdate?(state: BatchState): void;
}

export interface ScheduleResult {
  results: JobResult[];
  notRun: string[];
}

/**
 * Groups run sequentially by (provider, model) in first-seen order — each
 * model loads exactly once, the design's scheduling invariant, encoded here
 * rather than remembered by an operator. Within a group, at most
 * `max_in_flight` jobs run concurrently. A failing job becomes a JobResult
 * with `error`; it never takes the batch down.
 */
export async function schedule(o: ScheduleOptions): Promise<ScheduleResult> {
  const queuedAt = Date.now();

  const groups = new Map<string, ResolvedJob[]>();
  for (const j of o.jobs) {
    const key = `${j.run.provider} ${j.run.model}`;
    const list = groups.get(key) ?? [];
    list.push(j);
    groups.set(key, list);
  }

  const results: JobResult[] = [];
  const notRun: string[] = [];
  const running = new Set<string>();
  const done: string[] = [];
  const started = new Set<string>();

  const emit = (): void => {
    o.onUpdate?.({
      total: o.jobs.length,
      done: [...done],
      running: [...running],
      pending: o.jobs
        .filter((j) => !started.has(j.id) && !notRun.includes(j.id))
        .map((j) => j.id),
      not_run: [...notRun],
    });
  };

  for (const group of groups.values()) {
    const queue = [...group];
    const width = Math.min(Math.max(1, group[0]!.run.maxInFlight), group.length);
    const worker = async (): Promise<void> => {
      for (;;) {
        const job = queue.shift();
        if (!job) return;
        started.add(job.id);
        running.add(job.id);
        const startedAt = Date.now();
        emit();
        let env: Envelope | null = null;
        let error: string | undefined;
        try {
          env = await o.runJob(job);
        } catch (e) {
          error = e instanceof Error ? e.message : String(e);
        }
        running.delete(job.id);
        done.push(job.id);
        results.push({
          id: job.id,
          envelope: env,
          ...(error === undefined ? {} : { error }),
          queuedAt,
          startedAt,
          finishedAt: Date.now(),
        });
        emit();
      }
    };
    await Promise.all(Array.from({ length: width }, () => worker()));
  }

  emit();
  return { results, notRun };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test tests/batch/scheduler.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Typecheck, then commit**

Run: `bun run typecheck` — silent, exit 0.

```bash
git add src/batch/scheduler.ts tests/batch/scheduler.test.ts
git commit -m "feat: batch scheduler — grouped by model, capped in-group fan-out

'Never iterate models without explicit unload/load' stops being an operating
rule a human must remember and becomes a scheduling invariant: groups keyed
by (provider, model) drain sequentially, each inside a worker pool of
max_in_flight. A throwing job is a result with an error string — one refused
connection must not cost the other twenty-nine jobs."
```

---

### Task 13: Batch deadline and the progress file

The deadline means *stop starting new jobs*: running jobs finish, never-started ones are named `not_run` in the rollup — partial batch output stays usable. The progress file is the poll target that makes background execution workable: batches worth batching outlive a shell tool's timeout.

**Files:**
- Modify: `src/batch/scheduler.ts`
- Create: `src/batch/progress.ts`
- Test: `tests/batch/scheduler.test.ts` (append)
- Test: `tests/batch/progress.test.ts` (create)

**Interfaces:**
- Consumes: `BatchState` from `src/batch/scheduler.ts`.
- Produces: `ScheduleOptions.deadlineAt?: number` and `ScheduleOptions.reserveMs?: number` (default export `DEFAULT_BATCH_RESERVE_MS = 2000`); `writeProgress(path: string, state: BatchState): Promise<void>` in `src/batch/progress.ts`. Task 16 wires `--deadline-secs` and `--progress` to them.

- [ ] **Step 1: Write the failing tests**

Append to `tests/batch/scheduler.test.ts`:

```ts
describe("schedule deadline", () => {
  it("stops starting jobs at the deadline and names the ones that never ran", async () => {
    const ran: string[] = [];
    const { results, notRun } = await schedule({
      jobs: [job("a", "m"), job("b", "m"), job("c", "m"), job("d", "m")],
      runJob: async (j) => {
        ran.push(j.id);
        await Bun.sleep(120);
        return envelope(j.id);
      },
      deadlineAt: Date.now() + 200,
      reserveMs: 50,
    });
    expect(ran.length).toBeGreaterThan(0);
    expect(ran.length).toBeLessThan(4);
    expect(notRun.length).toBe(4 - ran.length);
    // Every job is accounted for exactly once — completed or named, never dropped.
    const all = [...results.map((r) => r.id), ...notRun].sort();
    expect(all).toEqual(["a", "b", "c", "d"]);
  });

  it("lets an already-running job finish rather than killing it", async () => {
    const { results } = await schedule({
      jobs: [job("slow", "m"), job("late", "m")],
      runJob: async (j) => {
        await Bun.sleep(150);
        return envelope(j.id);
      },
      deadlineAt: Date.now() + 100,
      reserveMs: 10,
    });
    // "slow" started before the deadline hit and completes with an envelope.
    expect(results.find((r) => r.id === "slow")!.envelope).not.toBeNull();
  });

  it("marks every job not_run when the deadline is already spent", async () => {
    const { results, notRun } = await schedule({
      jobs: [job("a", "m"), job("b", "m")],
      runJob: async (j) => envelope(j.id),
      deadlineAt: Date.now() - 1,
    });
    expect(results).toEqual([]);
    expect(notRun.sort()).toEqual(["a", "b"]);
  });

  it("surfaces not_run through onUpdate's final state", async () => {
    const states: BatchState[] = [];
    await schedule({
      jobs: [job("a", "m")],
      runJob: async (j) => envelope(j.id),
      deadlineAt: Date.now() - 1,
      onUpdate: (s) => states.push(structuredClone(s)),
    });
    expect(states[states.length - 1]!.not_run).toEqual(["a"]);
  });
});
```

Create `tests/batch/progress.test.ts`:

```ts
import { describe, it, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeProgress } from "../../src/batch/progress";

describe("writeProgress", () => {
  it("writes the state as one parseable JSON line", async () => {
    const dir = mkdtempSync(join(tmpdir(), "subagents-prog-"));
    const path = join(dir, "progress.json");
    try {
      await writeProgress(path, {
        total: 3, done: ["a"], running: ["b"], pending: ["c"], not_run: [],
      });
      const text = await Bun.file(path).text();
      expect(text.endsWith("\n")).toBe(true);
      const back = JSON.parse(text);
      expect(back).toEqual({
        total: 3, done: ["a"], running: ["b"], pending: ["c"], not_run: [],
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test tests/batch/scheduler.test.ts tests/batch/progress.test.ts`
Expected: FAIL — `deadlineAt` is not a known `ScheduleOptions` property (typecheck) and the deadline behavior is absent; cannot resolve `../../src/batch/progress`.

- [ ] **Step 3: Add deadline gating to `src/batch/scheduler.ts`**

Extend `ScheduleOptions`:

```ts
  /**
   * Absolute epoch-ms budget. Gates STARTS only: a running job finishes and
   * keeps its envelope; jobs never started land in `notRun` — named, not
   * silently dropped. The single-run deadline machinery handles in-flight
   * overruns; the batch's job is to stop feeding the queue.
   */
  deadlineAt?: number;
  /** Time reserved to assemble the rollup. */
  reserveMs?: number;
```

Add the default alongside it:

```ts
export const DEFAULT_BATCH_RESERVE_MS = 2000;
```

In `schedule`, insert at the top of the `worker` loop, replacing the bare `const job = queue.shift();`:

```ts
        if (
          o.deadlineAt !== undefined &&
          Date.now() + (o.reserveMs ?? DEFAULT_BATCH_RESERVE_MS) >= o.deadlineAt
        ) {
          for (const j of queue.splice(0)) notRun.push(j.id);
          emit();
          return;
        }
        const job = queue.shift();
```

The same check must also skip *later groups* entirely: wrap the per-group `await Promise.all(...)` in a guard that, once the deadline has passed, pushes the whole remaining group into `notRun` instead of spawning workers:

```ts
  for (const group of groups.values()) {
    if (
      o.deadlineAt !== undefined &&
      Date.now() + (o.reserveMs ?? DEFAULT_BATCH_RESERVE_MS) >= o.deadlineAt
    ) {
      for (const j of group) notRun.push(j.id);
      continue;
    }
    const queue = [...group];
    // ... unchanged worker-pool body ...
  }
```

- [ ] **Step 4: Create `src/batch/progress.ts`**

```ts
import type { BatchState } from "./scheduler";

/**
 * The poll target for background callers: one JSON line, rewritten whole on
 * every state change. Deliberately not atomic — a torn read costs the
 * poller one re-poll, and a rename dance would buy nothing a poller needs.
 */
export async function writeProgress(path: string, state: BatchState): Promise<void> {
  await Bun.write(path, `${JSON.stringify(state)}\n`);
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun test tests/batch/scheduler.test.ts tests/batch/progress.test.ts`
Expected: PASS. Then `bun test` — whole suite green.

- [ ] **Step 6: Typecheck, then commit**

Run: `bun run typecheck` — silent, exit 0.

```bash
git add src/batch/scheduler.ts src/batch/progress.ts tests/batch/scheduler.test.ts tests/batch/progress.test.ts
git commit -m "feat: batch deadline gates starts; progress file for background polls

The deadline stops the queue, not the work: running jobs keep their
envelopes, never-started jobs are named not_run — a partial batch the caller
knows is partial stays usable, the same principle as the single-run deadline.
The progress file is one rewritten JSON line; batches worth batching outlive
a shell timeout, so the caller polls instead of blocking."
```

---

### Task 14: Escalation helpers

The sweep-then-escalate recipe, moved inside the harness: decide which first-pass results earn a second attempt on a stronger tier, and merge the two passes into per-job reports. Pure functions here; Task 16 composes them into the batch command.

**Files:**
- Create: `src/batch/escalate.ts`
- Test: `tests/batch/escalate.test.ts`

**Interfaces:**
- Consumes: `JobResult` from `src/batch/scheduler.ts`; `Envelope` from `src/envelope.ts`.
- Produces: `needsEscalation(r: JobResult): boolean`, `interface Attempt { envelope: Envelope | null; error?: string; tier?: string }`, `interface JobReport { id: string; attempts: Attempt[]; final: Attempt }`, `mergeAttempts(first: JobResult[], second: JobResult[], escalatedTier: string): JobReport[]`. Task 15's rollup carries `JobReport[]`; Task 16 uses `needsEscalation` to pick the second-pass jobs.

- [ ] **Step 1: Write the failing tests**

Create `tests/batch/escalate.test.ts`:

```ts
import { describe, it, expect } from "bun:test";
import type { Envelope } from "../../src/envelope";
import type { JobResult } from "../../src/batch/scheduler";
import { mergeAttempts, needsEscalation } from "../../src/batch/escalate";

function env(overrides: Partial<Envelope> = {}): Envelope {
  return {
    status: "ok", summary: "s", turns: 1, wall_secs: 0.1,
    context: { peak_prompt_tokens: 1, limit: null, pressure: null },
    truncations: 0, local_tokens: 2, transcript: "/t.json",
    ...overrides,
  };
}

function res(id: string, envelope: Envelope | null, error?: string): JobResult {
  return {
    id, envelope, ...(error === undefined ? {} : { error }),
    queuedAt: 0, startedAt: 1, finishedAt: 2,
  };
}

describe("needsEscalation", () => {
  it("passes a clean ok result through", () => {
    expect(needsEscalation(res("a", env()))).toBe(false);
  });

  it("escalates every non-ok status", () => {
    for (const status of ["max_turns", "budget", "deadline", "error"]) {
      expect(needsEscalation(res("a", env({ status })))).toBe(true);
    }
  });

  it("escalates an ok result that worked blind — truncations are unsafe coverage", () => {
    expect(needsEscalation(res("a", env({ truncations: 2 })))).toBe(true);
  });

  it("escalates a job whose runner threw", () => {
    expect(needsEscalation(res("a", null, "connection refused"))).toBe(true);
  });
});

describe("mergeAttempts", () => {
  it("keeps single-attempt jobs as-is and stacks retried ones", () => {
    const first = [res("clean", env()), res("flaky", env({ status: "error" }))];
    const second = [res("flaky", env({ summary: "better" }))];
    const reports = mergeAttempts(first, second, "strong");

    const clean = reports.find((r) => r.id === "clean")!;
    expect(clean.attempts).toHaveLength(1);
    expect(clean.final.envelope!.status).toBe("ok");

    const flaky = reports.find((r) => r.id === "flaky")!;
    expect(flaky.attempts).toHaveLength(2);
    expect(flaky.attempts[1]!.tier).toBe("strong");
    expect(flaky.final.envelope!.summary).toBe("better");
  });

  it("keeps the second attempt as final even when it also failed — honesty over optimism", () => {
    const first = [res("stuck", env({ status: "error" }))];
    const second = [res("stuck", null, "still refused")];
    const r = mergeAttempts(first, second, "strong")[0]!;
    expect(r.final.envelope).toBeNull();
    expect(r.final.error).toBe("still refused");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test tests/batch/escalate.test.ts`
Expected: FAIL — cannot resolve `../../src/batch/escalate`.

- [ ] **Step 3: Create `src/batch/escalate.ts`**

```ts
import type { Envelope } from "../envelope";
import type { JobResult } from "./scheduler";

/**
 * A job worth a second, stronger attempt: it failed outright, stopped
 * early, or completed while working blind (truncations > 0 — its coverage
 * claims are unsafe, per the skill's trust rules).
 */
export function needsEscalation(r: JobResult): boolean {
  if (r.error !== undefined || r.envelope === null) return true;
  return r.envelope.status !== "ok" || r.envelope.truncations > 0;
}

export interface Attempt {
  envelope: Envelope | null;
  error?: string;
  /** Present on escalated attempts: the tier that ran it. */
  tier?: string;
}

export interface JobReport {
  id: string;
  /** In execution order; the escalated attempt, when present, is last. */
  attempts: Attempt[];
  /** The attempt that stands — always the last one, failed or not. */
  final: Attempt;
}

function toAttempt(r: JobResult, tier?: string): Attempt {
  return {
    envelope: r.envelope,
    ...(r.error === undefined ? {} : { error: r.error }),
    ...(tier === undefined ? {} : { tier }),
  };
}

/** Fold the escalation pass back onto the first, one report per job. */
export function mergeAttempts(
  first: JobResult[], second: JobResult[], escalatedTier: string,
): JobReport[] {
  const retries = new Map(second.map((r) => [r.id, r]));
  return first.map((r) => {
    const retry = retries.get(r.id);
    const attempts = [toAttempt(r)];
    if (retry) attempts.push(toAttempt(retry, escalatedTier));
    return { id: r.id, attempts, final: attempts[attempts.length - 1]! };
  });
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test tests/batch/escalate.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Typecheck, then commit**

Run: `bun run typecheck` — silent, exit 0.

```bash
git add src/batch/escalate.ts tests/batch/escalate.test.ts
git commit -m "feat: escalation policy and attempt merging

needsEscalation encodes the skill's own trust rules: non-ok status, a thrown
runner, or ok-but-truncated — a delegate that worked blind gets a stronger
second look rather than a pass. Reports keep both attempts; the final one
stands even when it also failed, because a rollup that quietly preferred the
older, weaker success would misreport what the strong tier actually said."
```

---

### Task 15: Rollup and concurrency evidence

One JSON object for the whole batch: per-job reports, the jobs that never ran, totals, and the concurrency evidence block — the harness reports what actually happened at the configured level; the caller reads it and tunes `max_in_flight`. No size cap: the rollup scales with N by the caller's own choice, and per-job envelopes are already individually bounded.

**Files:**
- Create: `src/batch/rollup.ts`
- Test: `tests/batch/rollup.test.ts`

**Interfaces:**
- Consumes: `JobResult` from `src/batch/scheduler.ts`; `JobReport` from `src/batch/escalate.ts`.
- Produces: `interface ConcurrencyEvidence { configured: number; achieved_throughput_per_min: number; latency_p50_secs: number; latency_max_secs: number; queue_wait_secs: number; timeouts: number; errors: number }`, `interface Rollup { status: "ok" | "partial" | "error"; jobs: JobReport[]; not_run: string[]; concurrency: ConcurrencyEvidence; wall_secs: number; local_tokens: number; transcript_dir: string }`, `buildRollup(o: { reports: JobReport[]; timings: JobResult[]; notRun: string[]; configured: number; wallSecs: number; transcriptDir: string }): Rollup`. Task 16 prints it.

- [ ] **Step 1: Write the failing tests**

Create `tests/batch/rollup.test.ts`:

```ts
import { describe, it, expect } from "bun:test";
import type { Envelope } from "../../src/envelope";
import type { JobResult } from "../../src/batch/scheduler";
import type { JobReport } from "../../src/batch/escalate";
import { buildRollup } from "../../src/batch/rollup";

function env(overrides: Partial<Envelope> = {}): Envelope {
  return {
    status: "ok", summary: "s", turns: 1, wall_secs: 0.1,
    context: { peak_prompt_tokens: 1, limit: null, pressure: null },
    truncations: 0, local_tokens: 100, transcript: "/t.json",
    ...overrides,
  };
}

function report(id: string, envelope: Envelope | null, error?: string): JobReport {
  const attempt = { envelope, ...(error === undefined ? {} : { error }) };
  return { id, attempts: [attempt], final: attempt };
}

function timing(id: string, startedAt: number, finishedAt: number, envelope: Envelope | null = env()): JobResult {
  return { id, envelope, queuedAt: 0, startedAt, finishedAt };
}

const base = { notRun: [], configured: 2, wallSecs: 60, transcriptDir: "/tmp/batch" };

describe("buildRollup status", () => {
  it("is ok when every final finished ok and everything ran", () => {
    const r = buildRollup({ ...base, reports: [report("a", env())], timings: [timing("a", 0, 1000)] });
    expect(r.status).toBe("ok");
  });

  it("is partial when some jobs finished ok and others did not", () => {
    const r = buildRollup({
      ...base,
      reports: [report("a", env()), report("b", env({ status: "error" }))],
      timings: [timing("a", 0, 1000), timing("b", 0, 1000)],
    });
    expect(r.status).toBe("partial");
  });

  it("is partial when jobs never ran, even if the rest are clean", () => {
    const r = buildRollup({
      ...base, notRun: ["c"],
      reports: [report("a", env())], timings: [timing("a", 0, 1000)],
    });
    expect(r.status).toBe("partial");
    expect(r.not_run).toEqual(["c"]);
  });

  it("is error when nothing finished ok", () => {
    const r = buildRollup({
      ...base,
      reports: [report("a", null, "refused"), report("b", env({ status: "deadline" }))],
      timings: [timing("a", 0, 1000, null), timing("b", 0, 1000, env({ status: "deadline" }))],
    });
    expect(r.status).toBe("error");
  });
});

describe("buildRollup evidence", () => {
  it("computes throughput, latency percentiles, and queue wait from timings", () => {
    const r = buildRollup({
      ...base,
      reports: [report("a", env()), report("b", env()), report("c", env())],
      timings: [
        timing("a", 200, 5_200),   // 5.0s latency, 0.2s wait
        timing("b", 400, 8_400),   // 8.0s latency, 0.4s wait
        timing("c", 600, 12_600),  // 12.0s latency, 0.6s wait
      ],
    });
    expect(r.concurrency.configured).toBe(2);
    expect(r.concurrency.achieved_throughput_per_min).toBe(3); // 3 jobs / 60s
    expect(r.concurrency.latency_p50_secs).toBe(8);
    expect(r.concurrency.latency_max_secs).toBe(12);
    expect(r.concurrency.queue_wait_secs).toBe(0.4); // mean of 0.2/0.4/0.6
  });

  it("counts timeouts and errors distinctly — their remedies differ", () => {
    const r = buildRollup({
      ...base,
      reports: [
        report("a", env({ status: "deadline" })),
        report("b", null, "refused"),
        report("c", env()),
      ],
      timings: [
        timing("a", 0, 1000, env({ status: "deadline" })),
        timing("b", 0, 1000, null),
        timing("c", 0, 1000),
      ],
    });
    expect(r.concurrency.timeouts).toBe(1);
    expect(r.concurrency.errors).toBe(1);
  });

  it("sums local_tokens across every attempt, escalations included", () => {
    const twoAttempts: JobReport = {
      id: "a",
      attempts: [
        { envelope: env({ status: "error", local_tokens: 300 }) },
        { envelope: env({ local_tokens: 700 }), tier: "strong" },
      ],
      final: { envelope: env({ local_tokens: 700 }), tier: "strong" },
    };
    const r = buildRollup({
      ...base, reports: [twoAttempts], timings: [timing("a", 0, 1000)],
    });
    expect(r.local_tokens).toBe(1000);
  });

  it("survives an empty batch outcome without NaN", () => {
    const r = buildRollup({ ...base, reports: [], timings: [], notRun: ["a", "b"] });
    expect(r.concurrency.latency_p50_secs).toBe(0);
    expect(r.concurrency.achieved_throughput_per_min).toBe(0);
    expect(Number.isNaN(r.concurrency.queue_wait_secs)).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test tests/batch/rollup.test.ts`
Expected: FAIL — cannot resolve `../../src/batch/rollup`.

- [ ] **Step 3: Create `src/batch/rollup.ts`**

```ts
import type { JobReport } from "./escalate";
import type { JobResult } from "./scheduler";

export interface ConcurrencyEvidence {
  configured: number;
  achieved_throughput_per_min: number;
  latency_p50_secs: number;
  latency_max_secs: number;
  queue_wait_secs: number;
  /** Jobs whose final envelope stopped at the deadline. */
  timeouts: number;
  /** Jobs that errored — thrown runner, unreadable response, or status "error". */
  errors: number;
}

export interface Rollup {
  status: "ok" | "partial" | "error";
  jobs: JobReport[];
  not_run: string[];
  concurrency: ConcurrencyEvidence;
  wall_secs: number;
  local_tokens: number;
  transcript_dir: string;
}

const round = (n: number, places: number): number => {
  const f = 10 ** places;
  return Math.round(n * f) / f;
};

/** Lower median — stable, and indifferent to a one-element tail. */
const p50 = (sorted: number[]): number =>
  sorted.length === 0 ? 0 : sorted[Math.floor((sorted.length - 1) / 2)]!;

/**
 * The evidence block exists because the throughput ceiling is a property of
 * host × model × prompt shape, not knowable in advance: the harness reports
 * what happened at the configured level, and the caller tunes
 * max_in_flight. A widening p50→max spread with flat throughput is queueing,
 * not parallelism; rising queue_wait says the same thing.
 */
export function buildRollup(o: {
  reports: JobReport[];
  /** Every attempt's timing, escalation pass included. */
  timings: JobResult[];
  notRun: string[];
  configured: number;
  wallSecs: number;
  transcriptDir: string;
}): Rollup {
  const clean = (r: JobReport): boolean =>
    r.final.envelope !== null && r.final.envelope.status === "ok";
  const allClean = o.reports.every(clean) && o.notRun.length === 0;
  const noneClean = o.reports.length > 0 && !o.reports.some(clean);
  const status = allClean ? "ok" : noneClean ? "error" : "partial";

  const latencies = o.timings
    .map((t) => (t.finishedAt - t.startedAt) / 1000)
    .sort((a, b) => a - b);
  const waits = o.timings.map((t) => (t.startedAt - t.queuedAt) / 1000);
  const meanWait = waits.length
    ? waits.reduce((sum, w) => sum + w, 0) / waits.length
    : 0;

  return {
    status,
    jobs: o.reports,
    not_run: o.notRun,
    concurrency: {
      configured: o.configured,
      achieved_throughput_per_min:
        o.wallSecs > 0 ? round(o.timings.length / (o.wallSecs / 60), 1) : 0,
      latency_p50_secs: round(p50(latencies), 1),
      latency_max_secs: round(latencies[latencies.length - 1] ?? 0, 1),
      queue_wait_secs: round(meanWait, 1),
      timeouts: o.reports.filter((r) => r.final.envelope?.status === "deadline").length,
      errors: o.reports.filter(
        (r) => r.final.error !== undefined || r.final.envelope === null ||
          r.final.envelope.status === "error",
      ).length,
    },
    wall_secs: round(o.wallSecs, 1),
    local_tokens: o.reports.reduce(
      (sum, r) => sum + r.attempts.reduce(
        (s, a) => s + (a.envelope?.local_tokens ?? 0), 0), 0),
    transcript_dir: o.transcriptDir,
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test tests/batch/rollup.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Typecheck, then commit**

Run: `bun run typecheck` — silent, exit 0.

```bash
git add src/batch/rollup.ts tests/batch/rollup.test.ts
git commit -m "feat: batch rollup with concurrency evidence

The evidence block is the design's answer to an unknowable ceiling: report
what actually happened at the configured level — throughput, p50/max spread,
queue wait, timeouts, errors — and let a reasoning caller tune
max_in_flight. Tokens sum across every attempt including escalations,
because that is what the batch actually cost."
```

---

### Task 16: `subagents batch` — CLI, end to end, docs

Compose everything: parse and fail fast, schedule the first pass, escalate the earners, merge, roll up, and keep the exit-code contract. Then the second documentation sweep.

**Files:**
- Modify: `src/cli.ts`
- Create: `jobs.example.yaml`
- Test: `tests/cli-batch.test.ts` (create)
- Modify: `README.md`, `skills/subagents/SKILL.md`, `docs/design.md`

**Interfaces:**
- Consumes: `parseJobs`/`resolveJobs`, `schedule`/`BatchState`/`ScheduleResult`, `needsEscalation`/`mergeAttempts`, `buildRollup`, `writeProgress`, `executeRun`, `resolveProfile`.
- Produces: the `subagents batch` command; nothing downstream.

- [ ] **Step 1: Write the failing tests**

Create `tests/cli-batch.test.ts`:

```ts
import { describe, it, expect, afterEach } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(import.meta.dir, "..", "src", "cli.ts");

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
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test tests/cli-batch.test.ts`
Expected: FAIL — `unknown command 'batch'` on stderr, exit 1, in every test.

- [ ] **Step 3: Add the batch command to `src/cli.ts`**

Five edits:

1. New imports:

```ts
import { parseJobs, resolveJobs, type ResolvedJob } from "./batch/jobs";
import { schedule, type BatchState, type ScheduleResult } from "./batch/scheduler";
import { needsEscalation, mergeAttempts, type JobReport } from "./batch/escalate";
import { buildRollup } from "./batch/rollup";
import { writeProgress } from "./batch/progress";
```

(`resolveProfile` is already imported.)

2. Extend `USAGE` — first line block becomes:

```text
subagents run --profile <name> --task <text> [options]
subagents batch --jobs <file> [options]
```

and after the existing run options add:

```text
Batch options:
  --jobs <file>           YAML file: jobs: [{id?, profile, task, root?, tier?}]. Required.
  --progress <path>       Progress file, rewritten on every job state change —
                          the poll target for long batches run in the background.
  --escalate-tier <name>  Re-run jobs that failed, stopped early, or worked
                          blind (truncations > 0) once on this tier.
  --transcript-dir <dir>  Per-job transcripts. Default: a temp directory.
  --deadline-secs <n>     Batch budget. Stops STARTING jobs; running jobs
                          finish, never-started ones are listed not_run.
  --config, --root, --verbose  as for run.
```

3. Parameterize `normalizeArgv` with the option set (it currently closes over `STRING_OPTS`):

```ts
function normalizeArgv(argv: string[], stringOpts: ReadonlySet<string>): string[] {
```

with the body's `STRING_OPTS.has(name)` becoming `stringOpts.has(name)`, and the existing `run` call site becoming `normalizeArgv(argv.slice(1), STRING_OPTS)`. Add:

```ts
const BATCH_STRING_OPTS = new Set([
  "jobs", "config", "root", "progress", "deadline-secs", "escalate-tier", "transcript-dir",
]);
```

4. Split dispatch in `main`. The current `run` handling moves to `runMain(argv: string[])` (rename only — the body is what `main` already does after the command checks), and `main` becomes:

```ts
async function main(argv: string[]): Promise<number> {
  const command = argv[0];
  if (command === "--help" || command === "-h") {
    process.stdout.write(USAGE);
    return 0;
  }
  if (!command) {
    process.stderr.write(USAGE);
    return 1;
  }
  if (command === "run") return runMain(argv.slice(1));
  if (command === "batch") return batchMain(argv.slice(1));
  process.stderr.write(`unknown command '${command}'\n\n${USAGE}`);
  return 1;
}
```

5. Add `batchMain`:

```ts
async function batchMain(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: normalizeArgv(argv, BATCH_STRING_OPTS),
    options: {
      jobs: { type: "string" },
      config: { type: "string" },
      root: { type: "string" },
      progress: { type: "string" },
      "escalate-tier": { type: "string" },
      "transcript-dir": { type: "string" },
      "deadline-secs": { type: "string" },
      verbose: { type: "boolean", default: false },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: false,
  });
  if (values.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (!values.jobs) {
    process.stderr.write(`missing required --jobs\n\n${USAGE}`);
    return 1;
  }
  if (!existsSync(values.jobs)) {
    process.stderr.write(`jobs file not found: ${values.jobs}\n`);
    return 1;
  }

  let deadlineSecs: number | undefined;
  if (values["deadline-secs"] !== undefined) {
    deadlineSecs = Number(values["deadline-secs"]);
    if (!Number.isFinite(deadlineSecs) || deadlineSecs <= 0) {
      process.stderr.write(
        `--deadline-secs must be a positive number, got ` +
          `${JSON.stringify(values["deadline-secs"])}\n`,
      );
      return 1;
    }
  }

  // Fail-fast zone: everything below throws to the top-level catch (exit 1,
  // nothing on stdout) until the first job starts.
  const cfg = parseConfig(await Bun.file(findConfig(values.config)).text());
  const specs = parseJobs(await Bun.file(values.jobs).text());
  const defaultRoot = resolve(values.root ?? process.cwd());
  const jobs = resolveJobs(cfg, specs, defaultRoot);
  const escalateTier = values["escalate-tier"];
  if (escalateTier !== undefined) {
    // An unknown escalation tier must fail before any run, not after the sweep.
    for (const j of jobs) resolveProfile(cfg, j.spec.profile, { tier: escalateTier });
  }

  const transcriptDir = values["transcript-dir"]
    ?? join(process.env["TMPDIR"] ?? "/tmp", `subagents-batch-${Date.now()}`);
  mkdirSync(transcriptDir, { recursive: true });

  const startedAt = Date.now();
  const deadlineAt = deadlineSecs === undefined ? undefined : startedAt + deadlineSecs * 1000;

  // Progress writes are advisory: swallowed failures must not slow or kill
  // the batch. But they are *chained*, not fire-and-forget — unordered
  // writes could let a stale state land after the final one, and the last
  // write must flush before the process exits or the poller's terminal
  // state never appears. During an escalation pass the file tracks that
  // pass's own jobs; the rollup is the cross-pass record.
  let progressChain: Promise<unknown> = Promise.resolve();
  const onUpdate = values.progress !== undefined
    ? (state: BatchState): void => {
        progressChain = progressChain
          .then(() => writeProgress(values.progress!, state))
          .catch(() => {});
      }
    : undefined;

  const runJob = (suffix: string) => (job: ResolvedJob) =>
    executeRun({
      run: job.run,
      task: job.spec.task,
      root: job.root,
      transcriptPath: join(transcriptDir, `${job.id}${suffix}.json`),
      ...(deadlineAt === undefined ? {} : { deadlineAt }),
      ...(process.env["SUBAGENTS_API_KEY"]
        ? { apiKey: process.env["SUBAGENTS_API_KEY"] }
        : {}),
      ...(values.verbose
        ? {
            onTurn: (turn: number, secs: number, names: string[]) =>
              process.stderr.write(
                `  [${job.id}${suffix}] turn ${turn}: ${secs.toFixed(1)}s ` +
                  `tools=[${names.join(", ")}]\n`),
          }
        : {}),
    }).then((o) => o.envelope);

  const first = await schedule({
    jobs,
    runJob: runJob(""),
    ...(deadlineAt === undefined ? {} : { deadlineAt }),
    ...(onUpdate ? { onUpdate } : {}),
  });

  let second: ScheduleResult = { results: [], notRun: [] };
  let reports: JobReport[];
  if (escalateTier !== undefined) {
    const failingIds = new Set(first.results.filter(needsEscalation).map((r) => r.id));
    if (failingIds.size > 0) {
      const retryJobs = resolveJobs(
        cfg,
        specs.filter((s) => failingIds.has(s.id)).map((s) => ({ ...s, tier: escalateTier })),
        defaultRoot,
      );
      // A deadline hit during escalation leaves first attempts standing —
      // visible as a single-attempt report, never a dropped job.
      second = await schedule({
        jobs: retryJobs,
        runJob: runJob(".escalated"),
        ...(deadlineAt === undefined ? {} : { deadlineAt }),
        ...(onUpdate ? { onUpdate } : {}),
      });
    }
    reports = mergeAttempts(first.results, second.results, escalateTier);
  } else {
    reports = mergeAttempts(first.results, [], "");
  }

  const rollup = buildRollup({
    reports,
    timings: [...first.results, ...second.results],
    notRun: first.notRun,
    configured: Math.max(...jobs.map((j) => j.run.maxInFlight)),
    wallSecs: (Date.now() - startedAt) / 1000,
    transcriptDir,
  });

  // Flush the last progress state before exiting — process.exit does not
  // wait for a pending Bun.write.
  await progressChain;

  // Compact single line, like the run envelope — machine-read first.
  process.stdout.write(`${JSON.stringify(rollup)}\n`);
  return rollup.status === "ok" ? 0 : 2;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test tests/cli-batch.test.ts`
Expected: PASS, 5 tests. Then `bun test && bun run typecheck` — whole suite green, typecheck silent.

- [ ] **Step 5: Create `jobs.example.yaml`**

```yaml
# subagents batch --jobs jobs.yaml [--escalate-tier strong] [--progress progress.json]
# Every job resolves against subagents.yaml before anything runs.
# id defaults to j1..jN; root defaults to --root (or cwd); tier overrides the profile's.
jobs:
  - { id: routes,  profile: digest, task: "List every route that validates its request body, with file:line." }
  - { id: loggers, profile: digest, task: "Enumerate every logger call site, with file:line." }
  - { id: risky,   profile: audit,  task: "Find unchecked array indexing in src/, with file:line." }
```

- [ ] **Step 6: Documentation sweep #2**

1. `README.md` — move batch from planned to shipped. In "What ships today" append:

```markdown
- `subagents batch`: N jobs from a YAML file, one rollup envelope. Jobs group
  by (provider, model) so each model loads once; `max_in_flight` caps
  per-provider fan-out; `--escalate-tier` re-runs failed or truncation-blind
  jobs on a stronger tier; `--progress` maintains a pollable state file; a
  batch deadline stops *starting* jobs and names the ones that never ran
```

and delete the `- Batch scheduling across multiple jobs and models` line from the planned list.

2. `skills/subagents/SKILL.md` — add after the **Tiering** section:

```markdown
## Batch: many jobs, one envelope

Thirty envelopes dispatched one at a time cost ~25k tokens across thirty
turns; one batch returns a single rollup. Delegate in batch whenever you have
more than a handful of jobs:

```bash
subagents batch --jobs jobs.yaml --escalate-tier strong \
  --deadline-secs 280 --progress /tmp/batch-progress.json
```

- Jobs group by (provider, model) — each model loads exactly once. Order in
  the file doesn't matter; grouping is the scheduler's job, not yours.
- `--escalate-tier` runs the sweep-then-escalate recipe inside one call:
  jobs that failed, stopped early, or worked blind (`truncations > 0`)
  re-run once on the named tier, and each job's report carries both attempts.
- The batch deadline stops *starting* jobs. `not_run` in the rollup names
  what never started — those jobs need a re-run, not an apology.
- For batches that outlive your shell timeout, run in the background and
  poll `--progress`: `{total, done, running, pending, not_run}`, one JSON line.
- Read `concurrency` before tuning: a widening p50→max latency spread with
  flat throughput is queueing, not parallelism — lower `max_in_flight`.
  Rising `queue_wait` says the same. And a ceiling measured on a shared host
  goes stale the moment someone else loads a model on it.
```

3. `docs/design.md` — status paragraph: batch scheduling now ships (grouping, concurrency evidence, progress file, deadline, escalation); the **Batch scheduling** section's design content stands as shipped behavior; MCP client, LM Studio adapter, `bash`, and the benchmark harness remain designed-not-built.

- [ ] **Step 7: Commit**

```bash
git add src/cli.ts jobs.example.yaml tests/cli-batch.test.ts README.md skills/subagents/SKILL.md docs/design.md
git commit -m "feat: subagents batch, end to end

Fail-fast resolution (a typo'd profile at job 29 of 30 must cost nothing),
grouped scheduling through the shared executeRun, optional escalation with
both attempts reported, and one compact rollup on stdout. Exit codes keep
the run contract: 0 all clean, 2 ran-but-read-it, 1 never started. The
skill gains the batch recipe: group-blind job files, escalate inside the
call, poll progress from the background, and read the concurrency evidence
before touching max_in_flight."
```

---

## Follow-on plans

Each produces working software on its own and depends only on this plan:

1. **`bash` tool** — model-callable command execution with timeout and config allow/deny patterns, write-profile-only, running inside the worktree. The test gate (harness-run) already exists; this is the delegate-driven counterpart, deferred here deliberately.
2. **LM Studio backend** — `subagents models` capability listing via `/api/v0/models`, residency and TTL control through `lms`, device-federation warnings, and a real `contextLimit` for envelope pressure (hardcoded `null` today).
3. **MCP client** — Streamable-HTTP client, per-tool allowlist with forced caps, `tools_omitted` in the envelope when a server is unreachable.
4. **Benchmark harness** — fixtures pairing a task with a deterministic oracle; now able to score *write* loops (does a small model hold an edit loop on real code? — the design's open question 1) as well as read loops.

## Verification

After every task: `bun test && bun run typecheck` (run `bun install` once first). The suite starts at 117 tests and grows with each task; report observed counts rather than matching a number stated here.

**Phase A live check** (optional; needs LM Studio with a tool-capable model — see docs/wiki/Recommended-Models.md):

```bash
cp subagents.example.yaml subagents.yaml   # edit base_url and model
mkdir /tmp/demo && cd /tmp/demo && git init -q
printf 'export function greet(): string {\n  return "Helo";\n}\n' > greet.ts
git add -A && git commit -qm "plant the typo"
cd - && bun src/cli.ts run --profile fix --root /tmp/demo --verbose \
  --task "greet() in greet.ts returns 'Helo'. Fix the typo so it returns 'Hello'." \
  --deadline-secs 120
```

Expected: `status: "ok"`, `files_changed` naming the file, a real `diffstat`, `test.passed: true` if a `test_cmd` is configured, the edit present in the reported `worktree` and absent from `/tmp/demo`, and exit 0.

**Phase B live check**:

```bash
bun src/cli.ts batch --jobs jobs.example.yaml --root . \
  --progress /tmp/subagents-progress.json --deadline-secs 280
```

Expected: a parseable one-line rollup, per-job transcripts in the reported `transcript_dir`, the progress file's final state showing every job done, and `concurrency` populated with plausible numbers.

## Self-Review

**Spec coverage.** Write tools with Claude Code semantics → Tasks 2–3 (read-before-write via Task 1's session). Worktree isolation default-on for write profiles → Tasks 4–5, wired in Task 8. Test gate, keep-don't-revert → Tasks 6 and 8 (decision locked with the user; design.md updated in Task 9). Envelope `files_changed`/`diffstat`/`test`/`worktree` + 1200 bound → Task 7. Exit-code contract extension → Task 8. Docs surfaces → Tasks 9 and 16. Batch: model grouping → Task 12; configured-then-tuned concurrency with evidence → Tasks 11/12/15; deadline stops starts + progress file → Task 13; escalation → Tasks 14/16; rollup → Task 15; fail-fast jobs file → Task 11. Deliberately deferred, restated in Follow-on plans: `bash`, LM Studio adapter, MCP client, benchmark harness. Known gap accepted: `context.limit`/`pressure` stay `null` until the LM Studio adapter.

**Placeholder scan.** No TBDs. Every code step carries complete, runnable code; the two docs tasks give exact replacement text. The one instruction-shaped step (Task 7's nine `600` → `MAX_ENVELOPE_CHARS` sites) names each site and the reason the rig derivations must track the bound.

**Type consistency.** `RunSession`/`ToolContext.session` (Task 1) are what Tasks 2–3 read and `runLoop` supplies. `ResolvedRun` grows in Task 4 (`worktree`, `testCmd`, `testTimeoutMs`) and Task 11 (`provider`, `maxInFlight`); the Task 12 test fixture constructs the full post-Task-11 shape. `WriteOutcome` (Task 7) is produced by Task 8/10 and consumed by `buildEnvelope`. `executeRun`'s `RunRequest`/`RunOutcome` (Task 10) are what Task 16's `runJob` calls. `JobResult` (Task 12) feeds `needsEscalation`/`mergeAttempts` (Task 14) and `buildRollup.timings` (Task 15); `JobReport` (Task 14) feeds `buildRollup.reports`. `BatchState` (Task 12) is what `writeProgress` (Task 13) serializes. Envelope fields referenced in batch tests (`status`, `truncations`, `local_tokens`, `summary`) all exist on `Envelope` as of Task 7.

