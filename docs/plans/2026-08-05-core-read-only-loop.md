# subagents Core Read-Only Loop — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A working `subagents run` command that delegates a read-only task to any OpenAI-compatible model and returns a small JSON envelope.

**Architecture:** A provider-agnostic agentic loop takes a backend and a list of tools as arguments and knows nothing about HTTP or the filesystem. Tools take a root and return `{content, truncated}`. Config resolves a named profile into a concrete run. The CLI wires these together and prints an envelope; the full message array is persisted to disk separately.

**Tech Stack:** Bun 1.3+, TypeScript, `bun:test`. Zero runtime dependencies — `Bun.YAML` parses config, `Bun.Glob` walks files, global `fetch` talks HTTP.

## Global Constraints

- Runtime is Bun; TypeScript with no build step. Verified available: Bun 1.3.5.
- **Zero runtime dependencies.** `devDependencies` may contain only `@types/bun` and `typescript`.
- **Mirror Claude Code's tool semantics exactly.** Deviation is a bug.
- **Never truncate silently.** Every truncated tool result ends with an explicit marker naming the range shown, the amount withheld, and how to continue.
- **Prompt economy is a hard constraint, not style.** The system prompt and every tool schema are re-sent on *every turn*, so each word is paid per-turn and directly drives latency — a measured 296-token turn took 2.4s against 11.0s for an 8,186-token one. Keep the system prompt and tool descriptions as short as they can be while retaining every load-bearing instruction. **Compress wording, never drop information:** the verbose truncation marker is what fixed a real coverage failure, so all four of its facts (range shown, amount withheld, how to continue, not-yet-complete) must survive any rewording.
- **Termination is "assistant message with no tool calls".** No terminator tool may ever be required.
- **Never overrun the caller's deadline.** The caller invokes this through a shell tool with a hard wall-clock limit (commonly 120s, max 600s). Being killed at that limit yields truncated stdout and no envelope, leaving the caller unable to tell whether any work happened. The loop must stop early and emit a valid envelope with `status: "deadline"` instead.
- Transcripts persist the **full message array**, not just API responses.
- Every filesystem path is confined to the run root via realpath; escapes throw.
- License MIT. Repository `https://github.com/andrhamm/subagents`. Do not add a git remote or push.

---

### Task 1: Project scaffold and config resolution

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `src/types.ts`
- Create: `src/config.ts`
- Test: `tests/config.test.ts`

**Interfaces:**
- Consumes: nothing (first task).
- Produces: `Config`, `ResolvedRun`, `parseConfig(text: string): Config`, `resolveProfile(cfg: Config, profileName: string, overrides?: {tier?: string}): ResolvedRun`. Types `Message`, `ToolSchema`, `ToolCall`, `AssistantMessage`, `Usage`, `ChatRequest`, `ChatResponse`, `Backend`, `SamplingParams` from `src/types.ts`.

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "subagents",
  "version": "0.1.0",
  "description": "Delegate scoped coding tasks to any OpenAI-compatible model",
  "license": "MIT",
  "repository": "https://github.com/andrhamm/subagents",
  "type": "module",
  "module": "src/cli.ts",
  "bin": { "subagents": "src/cli.ts" },
  "scripts": {
    "test": "bun test",
    "typecheck": "tsc --noEmit",
    "build": "bun build src/cli.ts --compile --outfile dist/subagents"
  },
  "devDependencies": {
    "@types/bun": "latest",
    "typescript": "^5"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "lib": ["ESNext"],
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "types": ["bun-types"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noEmit": true,
    "skipLibCheck": true,
    "verbatimModuleSyntax": true
  },
  "include": ["src", "tests"]
}
```

- [ ] **Step 3: Install dev dependencies**

Run: `bun install`
Expected: creates `bun.lock` and `node_modules`, no runtime dependencies listed.

- [ ] **Step 4: Create `src/types.ts`**

```ts
export interface SamplingParams {
  temperature?: number;
  top_p?: number;
  top_k?: number;
}

export interface ToolSchema {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: {
      type: "object";
      properties: Record<string, unknown>;
      required?: string[];
    };
  };
}

export interface ToolCall {
  id: string;
  type?: "function";
  function: { name: string; arguments: string };
}

export interface AssistantMessage {
  role: "assistant";
  content: string | null;
  tool_calls?: ToolCall[];
}

export type Message =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | AssistantMessage
  | { role: "tool"; tool_call_id: string; content: string };

export interface Usage {
  prompt_tokens?: number;
  completion_tokens?: number;
}

export interface ChatRequest {
  model: string;
  messages: Message[];
  tools?: ToolSchema[];
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  top_k?: number;
}

export interface ChatResponse {
  choices?: Array<{ message: AssistantMessage; finish_reason?: string }>;
  usage?: Usage;
}

export interface Backend {
  chat(req: ChatRequest, timeoutMs: number): Promise<ChatResponse>;
}
```

- [ ] **Step 5: Write the failing config tests**

Create `tests/config.test.ts`:

```ts
import { describe, it, expect } from "bun:test";
import { parseConfig, resolveProfile, DEFAULTS } from "../src/config";

const YAML_OK = `
providers:
  local: { base_url: "http://127.0.0.1:1234/v1", kind: lmstudio }
  cloud: { base_url: "https://api.example.com/v1/" }
sampling:
  gemma-factual: { temperature: 0.3, top_p: 0.95, top_k: 64 }
tiers:
  cheap: { provider: local, model: "google/gemma-4-e2b", sampling: gemma-factual }
  strong: { provider: cloud, model: "big-model" }
profiles:
  digest: { tools: [read_file, glob, grep], tier: cheap }
defaults:
  max_turns: 12
`;

describe("parseConfig", () => {
  it("parses a valid config", () => {
    const cfg = parseConfig(YAML_OK);
    expect(Object.keys(cfg.providers)).toEqual(["local", "cloud"]);
  });

  it("rejects a config missing a required section", () => {
    expect(() => parseConfig("providers: {}\ntiers: {}\n")).toThrow(/profiles/);
  });

  it("rejects a non-mapping config", () => {
    expect(() => parseConfig("- a\n- b\n")).toThrow(/mapping/);
  });
});

describe("resolveProfile", () => {
  it("resolves provider, model and sampling from the tier", () => {
    const r = resolveProfile(parseConfig(YAML_OK), "digest");
    expect(r.baseUrl).toBe("http://127.0.0.1:1234/v1");
    expect(r.kind).toBe("lmstudio");
    expect(r.model).toBe("google/gemma-4-e2b");
    expect(r.sampling).toEqual({ temperature: 0.3, top_p: 0.95, top_k: 64 });
    expect(r.tools).toEqual(["read_file", "glob", "grep"]);
  });

  it("applies defaults and lets config override them", () => {
    const r = resolveProfile(parseConfig(YAML_OK), "digest");
    expect(r.maxTurns).toBe(12);
    expect(r.maxTokens).toBe(DEFAULTS.maxTokens);
  });

  it("strips trailing slashes from base_url", () => {
    const r = resolveProfile(parseConfig(YAML_OK), "digest", { tier: "strong" });
    expect(r.baseUrl).toBe("https://api.example.com/v1");
  });

  it("defaults provider kind to openai", () => {
    const r = resolveProfile(parseConfig(YAML_OK), "digest", { tier: "strong" });
    expect(r.kind).toBe("openai");
  });

  it("names the known profiles when one is unknown", () => {
    expect(() => resolveProfile(parseConfig(YAML_OK), "nope")).toThrow(/digest/);
  });

  it("rejects an unknown tier override", () => {
    expect(() => resolveProfile(parseConfig(YAML_OK), "digest", { tier: "ghost" }))
      .toThrow(/ghost/);
  });
});
```

- [ ] **Step 6: Run the tests to verify they fail**

Run: `bun test tests/config.test.ts`
Expected: FAIL — cannot resolve module `../src/config`.

- [ ] **Step 7: Create `src/config.ts`**

```ts
import type { SamplingParams } from "./types";

export interface ProviderConfig {
  base_url: string;
  kind?: "openai" | "lmstudio";
}
export interface TierConfig {
  provider: string;
  model: string;
  sampling?: string;
}
export interface ProfileConfig {
  tools: string[];
  tier: string;
}
export interface Defaults {
  max_turns?: number;
  max_tokens?: number;
  timeout_ms?: number;
}
export interface Config {
  providers: Record<string, ProviderConfig>;
  sampling?: Record<string, SamplingParams>;
  tiers: Record<string, TierConfig>;
  profiles: Record<string, ProfileConfig>;
  defaults?: Defaults;
}

export interface ResolvedRun {
  baseUrl: string;
  kind: "openai" | "lmstudio";
  model: string;
  sampling: SamplingParams;
  tools: string[];
  maxTurns: number;
  maxTokens: number;
  timeoutMs: number;
}

export const DEFAULTS = {
  maxTurns: 20,
  maxTokens: 8000,
  timeoutMs: 300_000,
} as const;

const REQUIRED_SECTIONS = ["providers", "tiers", "profiles"] as const;

export function parseConfig(text: string): Config {
  const raw = Bun.YAML.parse(text) as unknown;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("config: top level must be a mapping");
  }
  const cfg = raw as Config;
  for (const section of REQUIRED_SECTIONS) {
    const value = cfg[section] as unknown;
    if (value === undefined || value === null || typeof value !== "object") {
      throw new Error(`config: missing required section '${section}'`);
    }
  }
  return cfg;
}

function known(record: Record<string, unknown>): string {
  const keys = Object.keys(record);
  return keys.length ? keys.join(", ") : "(none defined)";
}

export function resolveProfile(
  cfg: Config,
  profileName: string,
  overrides: { tier?: string } = {},
): ResolvedRun {
  const profile = cfg.profiles[profileName];
  if (!profile) {
    throw new Error(
      `unknown profile '${profileName}'. known profiles: ${known(cfg.profiles)}`,
    );
  }
  const tierName = overrides.tier ?? profile.tier;
  const tier = cfg.tiers[tierName];
  if (!tier) {
    throw new Error(`unknown tier '${tierName}'. known tiers: ${known(cfg.tiers)}`);
  }
  const provider = cfg.providers[tier.provider];
  if (!provider) {
    throw new Error(
      `unknown provider '${tier.provider}'. known providers: ${known(cfg.providers)}`,
    );
  }

  let sampling: SamplingParams = {};
  if (tier.sampling !== undefined) {
    const preset = cfg.sampling?.[tier.sampling];
    if (!preset) {
      throw new Error(
        `unknown sampling preset '${tier.sampling}'. known presets: ` +
          `${known(cfg.sampling ?? {})}`,
      );
    }
    sampling = preset;
  }

  const d = cfg.defaults ?? {};
  return {
    baseUrl: provider.base_url.replace(/\/+$/, ""),
    kind: provider.kind ?? "openai",
    model: tier.model,
    sampling,
    tools: profile.tools,
    maxTurns: d.max_turns ?? DEFAULTS.maxTurns,
    maxTokens: d.max_tokens ?? DEFAULTS.maxTokens,
    timeoutMs: d.timeout_ms ?? DEFAULTS.timeoutMs,
  };
}
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `bun test tests/config.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 9: Typecheck**

Run: `bun run typecheck`
Expected: no output, exit 0.

- [ ] **Step 10: Commit**

```bash
git add package.json tsconfig.json bun.lock src/types.ts src/config.ts tests/config.test.ts
git commit -m "feat: scaffold and config resolution

Profiles resolve to a concrete run: provider, model, sampling preset, tool
allowlist, and budgets. Unknown names list the known ones, because a typo in
a profile name should not require reading the source to fix."
```

---

### Task 2: OpenAI-compatible backend

**Files:**
- Create: `src/backends/base.ts`
- Test: `tests/backends/base.test.ts`

**Interfaces:**
- Consumes: `Backend`, `ChatRequest`, `ChatResponse` from `src/types.ts`.
- Produces: `class OpenAIBackend implements Backend` with `constructor(baseUrl: string, apiKey?: string)` and `chat(req, timeoutMs)`; `class BackendError extends Error`.

- [ ] **Step 1: Write the failing backend tests**

Create `tests/backends/base.test.ts`:

```ts
import { describe, it, expect, afterEach } from "bun:test";
import { OpenAIBackend, BackendError } from "../../src/backends/base";

let server: ReturnType<typeof Bun.serve> | undefined;

afterEach(() => {
  server?.stop(true);
  server = undefined;
});

function serve(handler: (req: Request) => Response | Promise<Response>): string {
  server = Bun.serve({ port: 0, fetch: handler });
  return `http://127.0.0.1:${server.port}/v1`;
}

describe("OpenAIBackend", () => {
  it("posts to /chat/completions and returns the parsed body", async () => {
    let seenPath = "";
    let seenBody: any = null;
    const url = serve(async (req) => {
      seenPath = new URL(req.url).pathname;
      seenBody = await req.json();
      return Response.json({
        choices: [{ message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 5, completion_tokens: 2 },
      });
    });
    const res = await new OpenAIBackend(url).chat(
      { model: "m", messages: [{ role: "user", content: "yo" }] }, 5000);
    expect(seenPath).toBe("/v1/chat/completions");
    expect(seenBody.model).toBe("m");
    expect(res.choices?.[0]?.message.content).toBe("hi");
    expect(res.usage?.prompt_tokens).toBe(5);
  });

  it("sends an Authorization header only when a key is given", async () => {
    const seen: Array<string | null> = [];
    const url = serve((req) => {
      seen.push(req.headers.get("authorization"));
      return Response.json({ choices: [] });
    });
    await new OpenAIBackend(url).chat({ model: "m", messages: [] }, 5000);
    await new OpenAIBackend(url, "sk-test").chat({ model: "m", messages: [] }, 5000);
    expect(seen[0]).toBeNull();
    expect(seen[1]).toBe("Bearer sk-test");
  });

  it("throws BackendError carrying the server's message on HTTP error", async () => {
    const url = serve(() => new Response("context length exceeded", { status: 500 }));
    const call = new OpenAIBackend(url).chat({ model: "m", messages: [] }, 5000);
    await expect(call).rejects.toThrow(BackendError);
    await expect(call).rejects.toThrow(/500.*context length exceeded/s);
  });

  it("throws BackendError on a non-JSON body", async () => {
    const url = serve(() => new Response("<html>nope</html>"));
    await expect(new OpenAIBackend(url).chat({ model: "m", messages: [] }, 5000))
      .rejects.toThrow(/non-JSON/);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test tests/backends/base.test.ts`
Expected: FAIL — cannot resolve module `../../src/backends/base`.

- [ ] **Step 3: Create `src/backends/base.ts`**

```ts
import type { Backend, ChatRequest, ChatResponse } from "../types";

export class BackendError extends Error {}

export class OpenAIBackend implements Backend {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey?: string,
  ) {}

  async chat(req: ChatRequest, timeoutMs: number): Promise<ChatResponse> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.apiKey) headers["authorization"] = `Bearer ${this.apiKey}`;

    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify(req),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      throw new BackendError(
        `request to ${this.baseUrl} failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }

    const text = await res.text();
    if (!res.ok) {
      throw new BackendError(`HTTP ${res.status}: ${text.slice(0, 500)}`);
    }
    try {
      return JSON.parse(text) as ChatResponse;
    } catch {
      throw new BackendError(`non-JSON response from ${this.baseUrl}: ${text.slice(0, 200)}`);
    }
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test tests/backends/base.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/backends/base.ts tests/backends/base.test.ts
git commit -m "feat: OpenAI-compatible backend

HTTP errors surface the server's own message rather than a generic failure —
an engine rejecting a request for exceeding context is a harness bug, and
hiding its text turns a five-second fix into a debugging session."
```

---

### Task 3: Path confinement and the `read_file` tool

This is the load-bearing task. Two of the three prototype bugs lived here.

**Files:**
- Create: `src/tools/types.ts`
- Create: `src/tools/paths.ts`
- Create: `src/tools/read.ts`
- Test: `tests/tools/read.test.ts`

**Interfaces:**
- Consumes: `ToolSchema` from `src/types.ts`.
- Produces: `interface ToolResult {content: string; truncated: boolean}`, `interface ToolContext {root: string}`, `interface Tool {name: string; schema: ToolSchema; run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>}`, `safePath(root: string, rel: string): string`, `MAX_READ_LINES`, and the `readFile: Tool` instance.

- [ ] **Step 1: Create `src/tools/types.ts`**

```ts
import type { ToolSchema } from "../types";

export interface ToolResult {
  content: string;
  /** True when output was cut short. Drives the envelope's truncation count. */
  truncated: boolean;
}

export interface ToolContext {
  root: string;
}

export interface Tool {
  name: string;
  schema: ToolSchema;
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}
```

- [ ] **Step 2: Write the failing tests**

Create `tests/tools/read.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { safePath } from "../../src/tools/paths";
import { readFile } from "../../src/tools/read";

// safePath realpaths its root, and on macOS mkdtemp gives /var/... while
// realpath gives /private/var/... — compare against the resolved form.
let root: string;
let realRoot: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "subagents-read-"));
  realRoot = realpathSync(root);
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "small.ts"), "alpha\nbravo\ncharlie\n");
  writeFileSync(
    join(root, "src", "big.ts"),
    Array.from({ length: 500 }, (_, i) => `line ${i + 1}`).join("\n") + "\n",
  );
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("safePath", () => {
  it("resolves a path inside the root", () => {
    expect(safePath(root, "src/small.ts")).toBe(join(realRoot, "src/small.ts"));
  });

  it("rejects a path escaping the root", () => {
    expect(() => safePath(root, "../../etc/passwd")).toThrow(/escapes root/);
  });

  it("rejects an absolute path outside the root", () => {
    expect(() => safePath(root, "/etc/passwd")).toThrow(/escapes root/);
  });
});

describe("read_file", () => {
  it("numbers every line, tab-separated, starting at 1", async () => {
    const r = await readFile.run({ path: "src/small.ts" }, { root });
    expect(r.content.split("\n")).toEqual([
      "     1\talpha",
      "     2\tbravo",
      "     3\tcharlie",
    ]);
    expect(r.truncated).toBe(false);
  });

  it("does not invent a trailing blank line", async () => {
    const r = await readFile.run({ path: "src/small.ts" }, { root });
    expect(r.content.endsWith("charlie")).toBe(true);
  });

  it("pages with offset and reports absolute line numbers", async () => {
    const r = await readFile.run({ path: "src/big.ts", offset: 200, limit: 2 }, { root });
    expect(r.content).toContain("   200\tline 200");
    expect(r.content).toContain("   201\tline 201");
    expect(r.content).not.toContain("line 199");
  });

  it("marks truncation explicitly with the withheld count and next offset", async () => {
    const r = await readFile.run({ path: "src/big.ts", limit: 190 }, { root });
    expect(r.truncated).toBe(true);
    expect(r.content).toContain("TRUNCATED");
    expect(r.content).toContain("lines 1-190 of 500");
    expect(r.content).toContain("310 not shown");
    expect(r.content).toContain("offset=191");
  });

  it("does not mark truncation when the whole file fits", async () => {
    const r = await readFile.run({ path: "src/big.ts", limit: 500 }, { root });
    expect(r.truncated).toBe(false);
    expect(r.content).not.toContain("TRUNCATED");
  });

  it("reports reaching end of file when paging past the start", async () => {
    const r = await readFile.run({ path: "src/big.ts", offset: 499 }, { root });
    expect(r.truncated).toBe(false);
    expect(r.content).toContain("end of file at line 500");
  });

  it("advertises offset and limit in its schema", () => {
    const props = readFile.schema.function.parameters.properties;
    expect(Object.keys(props).sort()).toEqual(["limit", "offset", "path"]);
    expect(readFile.schema.function.description).toContain("TRUNCATED");
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `bun test tests/tools/read.test.ts`
Expected: FAIL — cannot resolve `../../src/tools/paths`.

- [ ] **Step 4: Create `src/tools/paths.ts`**

```ts
import { existsSync, realpathSync } from "node:fs";
import { resolve, sep } from "node:path";

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
```

- [ ] **Step 5: Create `src/tools/read.ts`**

```ts
import type { Tool, ToolResult, ToolContext } from "./types";
import { safePath } from "./paths";

export const MAX_READ_LINES = 2000;

/** Split into lines without inventing a final empty line for a trailing newline. */
function toLines(text: string): string[] {
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

export const readFile: Tool = {
  name: "read_file",
  schema: {
    type: "function",
    function: {
      name: "read_file",
      description:
        `Read a text file with line numbers. Max ${MAX_READ_LINES} lines; a longer ` +
        "file ends with a TRUNCATED marker — page with offset before concluding.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path relative to the repo root." },
          offset: { type: "integer", description: "First line to read, 1-based." },
          limit: { type: "integer", description: "Maximum number of lines to read." },
        },
        required: ["path"],
      },
    },
  },

  async run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const path = safePath(ctx.root, String(args["path"]));
    const lines = toLines(await Bun.file(path).text());

    const start = Math.max(1, Number(args["offset"] ?? 1));
    const limit = Math.max(1, Number(args["limit"] ?? MAX_READ_LINES));
    const window = lines.slice(start - 1, start - 1 + limit);
    const body = window
      .map((line, i) => `${String(start + i).padStart(6)}\t${line}`)
      .join("\n");

    const end = start - 1 + window.length;
    const withheld = lines.length - end;

    if (withheld > 0) {
      return {
        // Four facts, deliberately: range shown, amount withheld, how to
        // continue, and that this is not the whole file. Reword freely; do
        // not drop any of them.
        content:
          `${body}\n[TRUNCATED: lines ${start}-${end} of ${lines.length}; ` +
          `${withheld} not shown. Continue with offset=${end + 1}. ` +
          "Incomplete — do not conclude yet.]",
        truncated: true,
      };
    }
    if (start > 1) {
      return { content: `${body}\n[end of file at line ${lines.length}]`, truncated: false };
    }
    return { content: body, truncated: false };
  },
};
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `bun test tests/tools/read.test.ts`
Expected: PASS, 10 tests (3 `safePath`, 7 `read_file`).

- [ ] **Step 7: Commit**

```bash
git add src/tools/types.ts src/tools/paths.ts src/tools/read.ts tests/tools/read.test.ts
git commit -m "feat: line-numbered, pageable read_file with explicit truncation

Both behaviours are load-bearing and were measured. Without line numbers a
model counts lines by hand and its citations drift several lines late; with
them, a 4.6B model cited exactly and fabricated nothing. Silent truncation is
worse still — it cut a 494-line file at line 190 and the resulting half-answer
looked like model laziness rather than a harness bug."
```

---

### Task 4: `glob`, `grep` and `list_dir`

**Files:**
- Create: `src/tools/search.ts`
- Test: `tests/tools/search.test.ts`

**Interfaces:**
- Consumes: `Tool`, `ToolResult`, `ToolContext` from `src/tools/types.ts`; `safePath` from `src/tools/paths.ts`.
- Produces: `glob: Tool`, `grep: Tool`, `listDir: Tool`, `MAX_MATCHES`, `MAX_FILES`.

- [ ] **Step 1: Write the failing tests**

Create `tests/tools/search.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { glob, grep, listDir, MAX_MATCHES } from "../../src/tools/search";

let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "subagents-search-"));
  mkdirSync(join(root, "src"));
  mkdirSync(join(root, "node_modules"));
  writeFileSync(join(root, "src", "a.ts"), "export const x = 1;\nconst y = validate(x);\n");
  writeFileSync(join(root, "src", "b.ts"), "const z = validate(2);\n");
  writeFileSync(join(root, "src", "notes.md"), "validate this prose\n");
  writeFileSync(join(root, "node_modules", "junk.ts"), "validate(999);\n");
  writeFileSync(
    join(root, "src", "many.ts"),
    Array.from({ length: MAX_MATCHES + 40 }, () => "needle").join("\n") + "\n",
  );
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("grep", () => {
  it("returns path:line:text for matches", async () => {
    const r = await grep.run({ pattern: "validate\\(", glob: "**/*.ts" }, { root });
    expect(r.content).toContain("src/a.ts:2:const y = validate(x);");
    expect(r.content).toContain("src/b.ts:1:const z = validate(2);");
  });

  it("honours the glob filter", async () => {
    const r = await grep.run({ pattern: "validate", glob: "**/*.md" }, { root });
    expect(r.content).toContain("notes.md");
    expect(r.content).not.toContain("a.ts");
  });

  it("skips node_modules", async () => {
    const r = await grep.run({ pattern: "validate\\(", glob: "**/*.ts" }, { root });
    expect(r.content).not.toContain("node_modules");
  });

  it("reports no matches plainly", async () => {
    const r = await grep.run({ pattern: "zzzznope" }, { root });
    expect(r.content).toBe("(no matches)");
    expect(r.truncated).toBe(false);
  });

  it("caps matches and says how many were withheld", async () => {
    const r = await grep.run({ pattern: "needle", glob: "**/many.ts" }, { root });
    expect(r.truncated).toBe(true);
    expect(r.content).toContain("TRUNCATED");
    expect(r.content).toContain(`showing ${MAX_MATCHES} of ${MAX_MATCHES + 40}`);
  });

  it("reports an invalid regex as a tool error, not a crash", async () => {
    await expect(grep.run({ pattern: "([unclosed" }, { root })).rejects.toThrow(/regex/i);
  });
});

describe("glob", () => {
  it("lists matching files relative to root", async () => {
    const r = await glob.run({ pattern: "src/*.ts" }, { root });
    const lines = r.content.split("\n").sort();
    expect(lines).toContain("src/a.ts");
    expect(lines).toContain("src/b.ts");
    expect(r.content).not.toContain("notes.md");
  });

  it("reports no matches plainly", async () => {
    const r = await glob.run({ pattern: "*.rs" }, { root });
    expect(r.content).toBe("(no matches)");
  });
});

describe("list_dir", () => {
  it("lists files under a directory and skips node_modules", async () => {
    const r = await listDir.run({ path: "." }, { root });
    expect(r.content).toContain("src/a.ts");
    expect(r.content).not.toContain("node_modules");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test tests/tools/search.test.ts`
Expected: FAIL — cannot resolve `../../src/tools/search`.

- [ ] **Step 3: Create `src/tools/search.ts`**

```ts
import { join } from "node:path";
import { Glob } from "bun";
import type { Tool, ToolResult, ToolContext } from "./types";
import { safePath } from "./paths";

export const MAX_MATCHES = 300;
export const MAX_FILES = 200;
const MAX_LINE = 200;

const SKIP_DIRS = new Set([".git", "node_modules", "dist", "build", ".next", "coverage"]);

function skipped(rel: string): boolean {
  return rel.split("/").some((seg) => SKIP_DIRS.has(seg));
}

async function* walk(root: string, pattern: string): AsyncGenerator<string> {
  const g = new Glob(pattern);
  for await (const rel of g.scan({ cwd: root, onlyFiles: true, dot: false })) {
    if (!skipped(rel)) yield rel;
  }
}

function capped(
  shown: string[], total: number, what: string, advice: string,
): ToolResult {
  if (total === 0) return { content: `(no ${what})`, truncated: false };
  if (total > shown.length) {
    return {
      content:
        `${shown.join("\n")}\n[TRUNCATED: showing ${shown.length} of ${total} ` +
        `${what}; ${total - shown.length} withheld. ${advice} Incomplete set.]`,
      truncated: true,
    };
  }
  return { content: shown.join("\n"), truncated: false };
}

export const grep: Tool = {
  name: "grep",
  schema: {
    type: "function",
    function: {
      name: "grep",
      description:
        "Search file contents by regex. Returns path:lineno:text. Capped; a " +
        "TRUNCATED marker reports how many matches were withheld.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Regular expression." },
          glob: {
            type: "string",
            description: "Optional file filter, e.g. '**/*.ts'. Defaults to all files.",
          },
        },
        required: ["pattern"],
      },
    },
  },

  async run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    let rx: RegExp;
    try {
      rx = new RegExp(String(args["pattern"]));
    } catch (e) {
      throw new Error(
        `invalid regex ${JSON.stringify(String(args["pattern"]))}: ` +
          `${e instanceof Error ? e.message : String(e)}`,
      );
    }
    const filter = String(args["glob"] ?? "**/*");
    const shown: string[] = [];
    let total = 0;

    for await (const rel of walk(ctx.root, filter)) {
      let text: string;
      try {
        text = await Bun.file(join(ctx.root, rel)).text();
      } catch {
        continue;
      }
      const lines = text.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? "";
        if (!rx.test(line)) continue;
        total++;
        if (shown.length < MAX_MATCHES) {
          shown.push(`${rel}:${i + 1}:${line.slice(0, MAX_LINE)}`);
        }
      }
    }
    return capped(shown, total, "matches", "Narrow the pattern or glob.");
  },
};

export const glob: Tool = {
  name: "glob",
  schema: {
    type: "function",
    function: {
      name: "glob",
      description:
        "Find files by shell glob, e.g. 'src/**/*.ts'. Capped with a TRUNCATED marker.",
      parameters: {
        type: "object",
        properties: { pattern: { type: "string", description: "Shell glob pattern." } },
        required: ["pattern"],
      },
    },
  },

  async run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const found: string[] = [];
    let total = 0;
    for await (const rel of walk(ctx.root, String(args["pattern"]))) {
      total++;
      if (found.length < MAX_FILES) found.push(rel);
    }
    return capped(found.sort(), total, "matches", "Narrow the pattern.");
  },
};

export const listDir: Tool = {
  name: "list_dir",
  schema: {
    type: "function",
    function: {
      name: "list_dir",
      description: "List files under a directory, recursively. Capped with a marker.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Directory relative to root. '.' for root." },
        },
        required: ["path"],
      },
    },
  },

  async run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const dir = safePath(ctx.root, String(args["path"]));
    const found: string[] = [];
    let total = 0;
    const g = new Glob("**/*");
    for await (const rel of g.scan({ cwd: dir, onlyFiles: true, dot: false })) {
      if (skipped(rel)) continue;
      total++;
      if (found.length < MAX_FILES) found.push(rel);
    }
    return capped(found.sort(), total, "files", "List a subdirectory instead.");
  },
};
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test tests/tools/search.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add src/tools/search.ts tests/tools/search.test.ts
git commit -m "feat: glob, grep and list_dir with capped, marked output

Deterministic search is where coverage should come from: grep enumerated 33
routes in 40ms with perfect recall where a model reading files found 16."
```

---

### Task 5: The agentic loop

**Files:**
- Create: `src/tools/registry.ts`
- Create: `src/loop.ts`
- Test: `tests/loop.test.ts`

**Interfaces:**
- Consumes: `Backend`, `ChatResponse`, `Message`, `Usage`, `AssistantMessage`, `SamplingParams` from `src/types.ts`; `Tool` from `src/tools/types.ts`; the four tool instances.
- Produces: `resolveTools(names: string[]): Tool[]`, `ALL_TOOLS: Record<string, Tool>`, `runLoop(o: LoopOptions): Promise<LoopResult>`, `DEFAULT_SYSTEM_PROMPT`, types `LoopOptions`, `LoopResult`, `LoopStatus`.

- [ ] **Step 1: Create `src/tools/registry.ts`**

```ts
import type { Tool } from "./types";
import { readFile } from "./read";
import { glob, grep, listDir } from "./search";

export const ALL_TOOLS: Record<string, Tool> = {
  [readFile.name]: readFile,
  [glob.name]: glob,
  [grep.name]: grep,
  [listDir.name]: listDir,
};

/** Resolve an allowlist of tool names, failing loudly on a typo. */
export function resolveTools(names: string[]): Tool[] {
  const out: Tool[] = [];
  const unknown: string[] = [];
  for (const name of names) {
    const tool = ALL_TOOLS[name];
    if (tool) out.push(tool);
    else unknown.push(name);
  }
  if (unknown.length) {
    throw new Error(
      `unknown tool(s): ${unknown.join(", ")}. available: ${Object.keys(ALL_TOOLS).join(", ")}`,
    );
  }
  return out;
}
```

- [ ] **Step 2: Write the failing loop tests**

Create `tests/loop.test.ts`:

```ts
import { describe, it, expect } from "bun:test";
import type { Backend, ChatRequest, ChatResponse } from "../src/types";
import type { Tool, ToolResult } from "../src/tools/types";
import { runLoop } from "../src/loop";
import { resolveTools } from "../src/tools/registry";

/** Backend that replays scripted responses and records what it was sent. */
class ScriptedBackend implements Backend {
  public seen: ChatRequest[] = [];
  constructor(private script: Array<ChatResponse | Error>) {}
  async chat(req: ChatRequest): Promise<ChatResponse> {
    this.seen.push(structuredClone(req));
    const next = this.script.shift();
    if (!next) throw new Error("script exhausted");
    if (next instanceof Error) throw next;
    return next;
  }
}

const assistant = (content: string | null, calls?: Array<[string, string, string]>) =>
  ({
    choices: [{
      message: {
        role: "assistant" as const,
        content,
        ...(calls
          ? { tool_calls: calls.map(([id, name, args]) => ({ id, function: { name, arguments: args } })) }
          : {}),
      },
      finish_reason: calls ? "tool_calls" : "stop",
    }],
    usage: { prompt_tokens: 100, completion_tokens: 10 },
  }) satisfies ChatResponse;

function fakeTool(name: string, result: ToolResult | Error): Tool {
  return {
    name,
    schema: {
      type: "function",
      function: { name, description: "d", parameters: { type: "object", properties: {} } },
    },
    async run() {
      if (result instanceof Error) throw result;
      return result;
    },
  };
}

const base = {
  model: "m",
  task: "do the thing",
  maxTurns: 10,
  maxTokens: 1000,
  sampling: {},
  timeoutMs: 5000,
  root: process.cwd(),
};

describe("runLoop termination", () => {
  it("treats content with no tool calls as completion", async () => {
    const backend = new ScriptedBackend([assistant("here is the answer")]);
    const r = await runLoop({ ...base, backend, tools: [] });
    expect(r.status).toBe("ok");
    expect(r.summary).toBe("here is the answer");
    expect(r.turns).toBe(1);
  });

  it("never requires a terminator tool to be offered", async () => {
    const backend = new ScriptedBackend([assistant("done")]);
    const r = await runLoop({ ...base, backend, tools: resolveTools(["read_file"]) });
    const names = backend.seen[0]!.tools!.map((t) => t.function.name);
    expect(names).toEqual(["read_file"]);
    expect(r.status).toBe("ok");
  });

  it("reports budget exhaustion from finish_reason=length", async () => {
    const backend = new ScriptedBackend([{
      choices: [{ message: { role: "assistant", content: "half an ans" }, finish_reason: "length" }],
    }]);
    const r = await runLoop({ ...base, backend, tools: [] });
    expect(r.status).toBe("budget");
    expect(r.detail).toContain("finish_reason=length");
  });

  it("stops at maxTurns and keeps the last assistant text", async () => {
    const call = assistant("thinking", [["1", "t", "{}"]]);
    const backend = new ScriptedBackend([call, call, call]);
    const r = await runLoop({
      ...base, backend, maxTurns: 2,
      tools: [fakeTool("t", { content: "ok", truncated: false })],
    });
    expect(r.status).toBe("max_turns");
    expect(r.turns).toBe(2);
    expect(r.summary).toBe("thinking");
  });
});

describe("runLoop tool dispatch", () => {
  it("executes a tool and feeds the result back as a tool message", async () => {
    const backend = new ScriptedBackend([
      assistant(null, [["c1", "t", '{"a":1}']]),
      assistant("finished"),
    ]);
    const r = await runLoop({
      ...base, backend, tools: [fakeTool("t", { content: "TOOL OUTPUT", truncated: false })],
    });
    expect(r.status).toBe("ok");
    const second = backend.seen[1]!.messages;
    const toolMsg = second.find((m) => m.role === "tool") as { content: string } | undefined;
    expect(toolMsg?.content).toBe("TOOL OUTPUT");
  });

  it("counts truncated tool results", async () => {
    const backend = new ScriptedBackend([
      assistant(null, [["c1", "t", "{}"]]),
      assistant("done"),
    ]);
    const r = await runLoop({
      ...base, backend, tools: [fakeTool("t", { content: "partial", truncated: true })],
    });
    expect(r.truncations).toBe(1);
  });

  it("feeds an unknown tool name back as an error and continues", async () => {
    const backend = new ScriptedBackend([
      assistant(null, [["c1", "ghost", "{}"]]),
      assistant("recovered"),
    ]);
    const r = await runLoop({ ...base, backend, tools: [] });
    expect(r.status).toBe("ok");
    const msg = backend.seen[1]!.messages.find((m) => m.role === "tool") as { content: string };
    expect(msg.content).toContain("unknown tool 'ghost'");
  });

  it("feeds malformed tool arguments back as an error and continues", async () => {
    const backend = new ScriptedBackend([
      assistant(null, [["c1", "t", "{not json"]]),
      assistant("recovered"),
    ]);
    const r = await runLoop({
      ...base, backend, tools: [fakeTool("t", { content: "unused", truncated: false })],
    });
    expect(r.status).toBe("ok");
    const msg = backend.seen[1]!.messages.find((m) => m.role === "tool") as { content: string };
    expect(msg.content).toContain("not valid JSON");
  });

  it("feeds a throwing tool back as an error and continues", async () => {
    const backend = new ScriptedBackend([
      assistant(null, [["c1", "t", "{}"]]),
      assistant("recovered"),
    ]);
    const r = await runLoop({
      ...base, backend, tools: [fakeTool("t", new Error("path escapes root: ../x"))],
    });
    expect(r.status).toBe("ok");
    const msg = backend.seen[1]!.messages.find((m) => m.role === "tool") as { content: string };
    expect(msg.content).toContain("path escapes root");
  });

  it("runs every tool call in a multi-call turn", async () => {
    const backend = new ScriptedBackend([
      assistant(null, [["c1", "t", "{}"], ["c2", "t", "{}"], ["c3", "t", "{}"]]),
      assistant("done"),
    ]);
    await runLoop({
      ...base, backend, tools: [fakeTool("t", { content: "x", truncated: false })],
    });
    const toolMsgs = backend.seen[1]!.messages.filter((m) => m.role === "tool");
    expect(toolMsgs).toHaveLength(3);
  });
});

describe("runLoop deadline", () => {
  /** Backend whose every reply takes `delayMs`, so turn duration is controllable. */
  class SlowBackend implements Backend {
    public calls = 0;
    public timeouts: number[] = [];
    constructor(private delayMs: number) {}
    async chat(_req: ChatRequest, timeoutMs: number): Promise<ChatResponse> {
      this.calls++;
      this.timeouts.push(timeoutMs);
      await Bun.sleep(this.delayMs);
      return assistant(`turn ${this.calls}`, [["c", "t", "{}"]]);
    }
  }

  it("stops with status deadline rather than starting a turn it cannot finish", async () => {
    const backend = new SlowBackend(120);
    const r = await runLoop({
      ...base, backend, maxTurns: 50,
      tools: [fakeTool("t", { content: "x", truncated: false })],
      deadlineAt: Date.now() + 400,
      wrapupReserveMs: 50,
    });
    expect(r.status).toBe("deadline");
    // Ran at least once, but nowhere near maxTurns.
    expect(r.turns).toBeGreaterThan(0);
    expect(r.turns).toBeLessThan(10);
    expect(r.detail).toMatch(/worst observed turn|deadline reached/);
  });

  it("keeps the last assistant text as the partial summary", async () => {
    const backend = new SlowBackend(120);
    const r = await runLoop({
      ...base, backend, maxTurns: 50,
      tools: [fakeTool("t", { content: "x", truncated: false })],
      deadlineAt: Date.now() + 400,
      wrapupReserveMs: 50,
    });
    expect(r.summary).toMatch(/^turn \d+$/);
  });

  it("stops immediately when the deadline has already passed", async () => {
    const backend = new SlowBackend(10);
    const r = await runLoop({
      ...base, backend, tools: [],
      deadlineAt: Date.now() - 1,
      wrapupReserveMs: 50,
    });
    expect(r.status).toBe("deadline");
    expect(r.turns).toBe(0);
    expect(backend.calls).toBe(0);
    expect(r.detail).toContain("deadline reached before turn 1");
  });

  it("clamps the per-request timeout to the remaining budget", async () => {
    const backend = new SlowBackend(10);
    await runLoop({
      ...base, backend, maxTurns: 1, timeoutMs: 300_000,
      tools: [fakeTool("t", { content: "x", truncated: false })],
      deadlineAt: Date.now() + 5_000,
      wrapupReserveMs: 1_000,
    });
    // Budget was ~4s after reserve, far below the configured 300s.
    expect(backend.timeouts[0]!).toBeLessThan(5_000);
    expect(backend.timeouts[0]!).toBeGreaterThan(0);
  });

  it("never clamps the request timeout below a usable floor", async () => {
    const backend = new SlowBackend(1);
    await runLoop({
      ...base, backend, maxTurns: 1, timeoutMs: 300_000,
      tools: [fakeTool("t", { content: "x", truncated: false })],
      deadlineAt: Date.now() + 1_100,
      wrapupReserveMs: 1_000,
    });
    expect(backend.timeouts[0]!).toBeGreaterThanOrEqual(1_000);
  });

  it("runs to normal completion when no deadline is given", async () => {
    const backend = new ScriptedBackend([assistant("done")]);
    const r = await runLoop({ ...base, backend, tools: [] });
    expect(r.status).toBe("ok");
  });
});

describe("runLoop errors", () => {
  it("returns error status when the backend throws", async () => {
    const backend = new ScriptedBackend([new Error("connection refused")]);
    const r = await runLoop({ ...base, backend, tools: [] });
    expect(r.status).toBe("error");
    expect(r.detail).toContain("connection refused");
  });

  it("returns error status when the response has no choices", async () => {
    const backend = new ScriptedBackend([{ choices: [] }]);
    const r = await runLoop({ ...base, backend, tools: [] });
    expect(r.status).toBe("error");
    expect(r.detail).toContain("no choices");
  });

  it("passes sampling parameters through to the backend", async () => {
    const backend = new ScriptedBackend([assistant("done")]);
    await runLoop({
      ...base, backend, tools: [],
      sampling: { temperature: 0.3, top_p: 0.95, top_k: 64 },
    });
    expect(backend.seen[0]!.temperature).toBe(0.3);
    expect(backend.seen[0]!.top_k).toBe(64);
  });

  it("records the full message array including tool results", async () => {
    const backend = new ScriptedBackend([
      assistant(null, [["c1", "t", "{}"]]),
      assistant("done"),
    ]);
    const r = await runLoop({
      ...base, backend, tools: [fakeTool("t", { content: "seen", truncated: false })],
    });
    const roles = r.messages.map((m) => m.role);
    expect(roles).toEqual(["system", "user", "assistant", "tool", "assistant"]);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `bun test tests/loop.test.ts`
Expected: FAIL — cannot resolve `../src/loop`.

- [ ] **Step 4: Create `src/loop.ts`**

```ts
import type {
  AssistantMessage, Backend, ChatResponse, Message, SamplingParams, Usage,
} from "./types";
import type { Tool } from "./tools/types";

export type LoopStatus = "ok" | "max_turns" | "budget" | "deadline" | "error";

/** Time reserved to write the transcript and emit the envelope. */
export const DEFAULT_WRAPUP_RESERVE_MS = 3000;

export interface LoopOptions {
  backend: Backend;
  model: string;
  tools: Tool[];
  task: string;
  systemPrompt?: string;
  maxTurns: number;
  maxTokens: number;
  sampling: SamplingParams;
  timeoutMs: number;
  root: string;
  /** Absolute epoch-ms budget. Omit for no deadline. */
  deadlineAt?: number;
  /** Override the wrap-up reserve. */
  wrapupReserveMs?: number;
  onTurn?: (turn: number, secs: number, toolNames: string[]) => void;
}

export interface LoopResult {
  status: LoopStatus;
  summary: string;
  detail: string;
  turns: number;
  messages: Message[];
  usage: Usage[];
  truncations: number;
}

// Re-sent every turn, so every word is paid per-turn and adds latency. Five
// load-bearing rules, each earned from an observed failure. Compress wording
// freely; do not drop a rule.
export const DEFAULT_SYSTEM_PROMPT =
  "Coding agent in a repository. Inspect with tools, then answer.\n" +
  "Cite paths and line numbers exactly as shown in numbered reads.\n" +
  "TRUNCATED means you have not seen all of it — read the rest before concluding.\n" +
  "List what you found; never state totals or counts.\n" +
  "When you have the answer, state it directly; do not call another tool.";

export async function runLoop(o: LoopOptions): Promise<LoopResult> {
  const byName = new Map(o.tools.map((t) => [t.name, t]));
  const schemas = o.tools.map((t) => t.schema);
  const messages: Message[] = [
    { role: "system", content: o.systemPrompt ?? DEFAULT_SYSTEM_PROMPT },
    { role: "user", content: o.task },
  ];
  const usage: Usage[] = [];
  let truncations = 0;
  let turns = 0;

  const done = (
    status: LoopStatus, summary: string, detail: string,
  ): LoopResult => ({ status, summary, detail, turns, messages, usage, truncations });

  const reserve = o.wrapupReserveMs ?? DEFAULT_WRAPUP_RESERVE_MS;
  const lastText = (): string =>
    [...messages].reverse().find(
      (m): m is AssistantMessage => m.role === "assistant")?.content ?? "";
  /** Worst turn seen so far. The tail overruns budgets, not the mean. */
  let worstTurnMs = 0;

  while (turns < o.maxTurns) {
    if (o.deadlineAt !== undefined) {
      const remaining = o.deadlineAt - Date.now();
      if (remaining <= reserve) {
        return done("deadline", lastText(),
          `deadline reached before turn ${turns + 1}; ` +
          `${Math.round(remaining / 1000)}s left, ${Math.round(reserve / 1000)}s reserved ` +
          "to emit this envelope");
      }
      if (turns > 0 && remaining - worstTurnMs < reserve) {
        return done("deadline", lastText(),
          `stopped after ${turns} turn(s): ${Math.round(remaining / 1000)}s of budget left ` +
          `but the worst observed turn took ${Math.round(worstTurnMs / 1000)}s`);
      }
    }

    turns++;
    const started = Date.now();

    // A configured request timeout longer than the remaining budget is
    // incoherent — one slow call would overrun despite the gate above.
    let timeoutMs = o.timeoutMs;
    if (o.deadlineAt !== undefined) {
      timeoutMs = Math.max(1000, Math.min(timeoutMs, o.deadlineAt - Date.now() - reserve));
    }

    let res: ChatResponse;
    try {
      res = await o.backend.chat(
        {
          model: o.model,
          messages,
          ...(schemas.length ? { tools: schemas } : {}),
          max_tokens: o.maxTokens,
          ...o.sampling,
        },
        timeoutMs,
      );
    } catch (e) {
      return done("error", "", e instanceof Error ? e.message : String(e));
    }

    worstTurnMs = Math.max(worstTurnMs, Date.now() - started);

    if (res.usage) usage.push(res.usage);

    const choice = res.choices?.[0];
    if (!choice) {
      return done(
        "error", "",
        `response had no choices: ${JSON.stringify(res).slice(0, 400)}`,
      );
    }

    const msg = choice.message;
    const calls = msg.tool_calls ?? [];
    o.onTurn?.(turns, (Date.now() - started) / 1000, calls.map((c) => c.function.name));

    if (choice.finish_reason === "length") {
      return done(
        "budget", msg.content ?? "",
        "finish_reason=length: the token budget ran out before the answer completed. " +
          "Raise max_tokens, or the loaded context window.",
      );
    }

    // Completion: the agent stopped asking for tools. No terminator tool needed.
    if (calls.length === 0) {
      messages.push({ role: "assistant", content: msg.content ?? "" });
      return done("ok", msg.content ?? "", "");
    }

    messages.push({ role: "assistant", content: msg.content ?? "", tool_calls: calls });

    for (const call of calls) {
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: await dispatch(call.function.name, call.function.arguments, byName, o,
          () => { truncations++; }),
      });
    }
  }

  return done(
    "max_turns", lastText(),
    `hit max_turns=${o.maxTurns} without a final answer`,
  );
}

async function dispatch(
  name: string,
  rawArgs: string,
  byName: Map<string, Tool>,
  o: LoopOptions,
  onTruncated: () => void,
): Promise<string> {
  const tool = byName.get(name);
  if (!tool) {
    return `ERROR: unknown tool '${name}'. Available: ${[...byName.keys()].join(", ") || "(none)"}`;
  }
  let args: Record<string, unknown>;
  try {
    args = JSON.parse(rawArgs || "{}") as Record<string, unknown>;
  } catch (e) {
    return `ERROR: arguments were not valid JSON (${
      e instanceof Error ? e.message : String(e)
    }). Retry this call with valid JSON.`;
  }
  try {
    const result = await tool.run(args, { root: o.root });
    if (result.truncated) onTruncated();
    return result.content;
  } catch (e) {
    return `ERROR: ${e instanceof Error ? e.message : String(e)}`;
  }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun test tests/loop.test.ts`
Expected: PASS, 16 tests.

- [ ] **Step 6: Commit**

```bash
git add src/tools/registry.ts src/loop.ts tests/loop.test.ts
git commit -m "feat: agentic loop with no-tool-calls termination

Requiring a terminator tool call was a prototype mistake that recorded a
correct 5/6 answer as a failure, because a small model answered in prose
instead. Content with no tool calls is completion. Tool errors — unknown
name, malformed arguments, a throwing tool — are fed back so the model can
recover, rather than aborting the run."
```

---

### Task 6: Transcript and envelope

**Files:**
- Create: `src/transcript.ts`
- Create: `src/envelope.ts`
- Test: `tests/envelope.test.ts`

**Interfaces:**
- Consumes: `LoopResult` from `src/loop.ts`; `Message`, `Usage` from `src/types.ts`.
- Produces: `writeTranscript(path: string, data: TranscriptData): Promise<void>`, `interface TranscriptData`, `buildEnvelope(r: LoopResult, o: EnvelopeInputs): Envelope`, `interface Envelope`, `interface EnvelopeInputs`.

- [ ] **Step 1: Write the failing tests**

Create `tests/envelope.test.ts`:

```ts
import { describe, it, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LoopResult } from "../src/loop";
import { buildEnvelope } from "../src/envelope";
import { writeTranscript } from "../src/transcript";

const result: LoopResult = {
  status: "ok",
  summary: "found six routes",
  detail: "",
  turns: 3,
  messages: [
    { role: "system", content: "s" },
    { role: "user", content: "u" },
    { role: "assistant", content: "a" },
  ],
  usage: [
    { prompt_tokens: 500, completion_tokens: 20 },
    { prompt_tokens: 8000, completion_tokens: 60 },
    { prompt_tokens: 21628, completion_tokens: 100 },
  ],
  truncations: 2,
};

describe("buildEnvelope", () => {
  it("reports peak prompt tokens and context pressure", () => {
    const e = buildEnvelope(result, {
      wallSecs: 12.04, transcript: "/t.json", contextLimit: 32768,
    });
    expect(e.context.peak_prompt_tokens).toBe(21628);
    expect(e.context.limit).toBe(32768);
    expect(e.context.pressure).toBe(0.66);
  });

  it("leaves pressure null when the context limit is unknown", () => {
    const e = buildEnvelope(result, {
      wallSecs: 1, transcript: "/t.json", contextLimit: null,
    });
    expect(e.context.pressure).toBeNull();
  });

  it("sums all tokens spent on the delegate", () => {
    const e = buildEnvelope(result, {
      wallSecs: 1, transcript: "/t.json", contextLimit: null,
    });
    expect(e.local_tokens).toBe(500 + 20 + 8000 + 60 + 21628 + 100);
  });

  it("carries the truncation count so blind runs are visible", () => {
    const e = buildEnvelope(result, {
      wallSecs: 1, transcript: "/t.json", contextLimit: null,
    });
    expect(e.truncations).toBe(2);
  });

  it("rounds wall seconds to one decimal", () => {
    const e = buildEnvelope(result, {
      wallSecs: 12.04, transcript: "/t.json", contextLimit: null,
    });
    expect(e.wall_secs).toBe(12);
  });

  it("omits detail when empty and includes it when set", () => {
    const ok = buildEnvelope(result, { wallSecs: 1, transcript: "/t", contextLimit: null });
    expect(ok.detail).toBeUndefined();
    const bad = buildEnvelope(
      { ...result, status: "error", detail: "connection refused" },
      { wallSecs: 1, transcript: "/t", contextLimit: null },
    );
    expect(bad.detail).toBe("connection refused");
  });

  it("stays small — the whole point of the envelope", () => {
    const e = buildEnvelope(result, { wallSecs: 1, transcript: "/t", contextLimit: 32768 });
    expect(JSON.stringify(e).length).toBeLessThan(600);
  });
});

describe("writeTranscript", () => {
  it("persists the full message array, not just responses", async () => {
    const dir = mkdtempSync(join(tmpdir(), "subagents-tr-"));
    const path = join(dir, "t.json");
    await writeTranscript(path, {
      model: "m", task: "t", status: "ok",
      messages: result.messages, usage: result.usage,
    });
    const back = await Bun.file(path).json();
    expect(back.messages).toHaveLength(3);
    expect(back.messages[0].role).toBe("system");
    expect(back.usage).toHaveLength(3);
    rmSync(dir, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test tests/envelope.test.ts`
Expected: FAIL — cannot resolve `../src/envelope`.

- [ ] **Step 3: Create `src/transcript.ts`**

```ts
import type { Message, Usage } from "./types";

export interface TranscriptData {
  model: string;
  task: string;
  status: string;
  messages: Message[];
  usage: Usage[];
}

/**
 * Persist the whole conversation, including tool results.
 * Saving only API responses makes questions like "what did the model actually
 * see?" unanswerable after the fact.
 */
export async function writeTranscript(path: string, data: TranscriptData): Promise<void> {
  await Bun.write(path, JSON.stringify(data, null, 1));
}
```

- [ ] **Step 4: Create `src/envelope.ts`**

```ts
import type { LoopResult } from "./loop";

export interface Envelope {
  status: string;
  summary: string;
  detail?: string;
  turns: number;
  wall_secs: number;
  context: {
    peak_prompt_tokens: number;
    limit: number | null;
    pressure: number | null;
  };
  truncations: number;
  local_tokens: number;
  transcript: string;
}

export interface EnvelopeInputs {
  wallSecs: number;
  transcript: string;
  contextLimit: number | null;
}

const round = (n: number, places: number): number => {
  const f = 10 ** places;
  return Math.round(n * f) / f;
};

export function buildEnvelope(r: LoopResult, o: EnvelopeInputs): Envelope {
  const prompts = r.usage.map((u) => u.prompt_tokens ?? 0);
  const peak = prompts.length ? Math.max(...prompts) : 0;
  return {
    status: r.status,
    summary: r.summary,
    ...(r.detail ? { detail: r.detail } : {}),
    turns: r.turns,
    wall_secs: round(o.wallSecs, 1),
    context: {
      peak_prompt_tokens: peak,
      limit: o.contextLimit,
      pressure: o.contextLimit ? round(peak / o.contextLimit, 2) : null,
    },
    truncations: r.truncations,
    local_tokens: r.usage.reduce(
      (sum, u) => sum + (u.prompt_tokens ?? 0) + (u.completion_tokens ?? 0), 0),
    transcript: o.transcript,
  };
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun test tests/envelope.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 6: Commit**

```bash
git add src/transcript.ts src/envelope.ts tests/envelope.test.ts
git commit -m "feat: small envelope out, full transcript to disk

truncations and context.pressure are in the envelope so the caller can see
the delegate was working blind without reading the transcript — the failure
mode that made a half-read file look like model laziness."
```

---

### Task 7: CLI wiring, end to end

**Files:**
- Create: `src/cli.ts`
- Create: `subagents.example.yaml`
- Test: `tests/cli.test.ts`

**Interfaces:**
- Consumes: everything above — `parseConfig`, `resolveProfile`, `OpenAIBackend`, `resolveTools`, `runLoop`, `buildEnvelope`, `writeTranscript`.
- Produces: the `subagents` executable, supporting `subagents run --profile <name> --task <text> [--root <dir>] [--tier <name>] [--config <path>] [--transcript <path>] [--verbose]`.

- [ ] **Step 1: Create `subagents.example.yaml`**

```yaml
# Copy to subagents.yaml and edit. Resolution order for --config:
#   explicit --config, then ./subagents.yaml, then ~/.config/subagents/config.yaml
providers:
  local: { base_url: "http://127.0.0.1:1234/v1", kind: lmstudio }

# Sampling is per model family. There is no universal setting, and wrong values
# produce wrong results that look real. Cite a source for anything added here.
sampling:
  # Gemma vendor guidance for factual/extraction work (0.1-0.3 factual).
  gemma-factual: { temperature: 0.3, top_p: 0.95, top_k: 64 }
  # Qwen3 non-thinking, vendor published. Qwen forbids greedy decoding.
  qwen-nonthinking: { temperature: 0.7, top_p: 0.8, top_k: 20 }

tiers:
  cheap: { provider: local, model: "google/gemma-4-e2b", sampling: gemma-factual }
  strong: { provider: local, model: "qwen3-coder-next", sampling: qwen-nonthinking }

profiles:
  digest: { tools: [read_file, glob, grep, list_dir], tier: cheap }
  audit: { tools: [read_file, glob, grep, list_dir], tier: strong }

defaults:
  max_turns: 20
  max_tokens: 8000
  timeout_ms: 300000
```

- [ ] **Step 2: Write the failing CLI test**

Create `tests/cli.test.ts`:

```ts
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
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `bun test tests/cli.test.ts`
Expected: FAIL — `src/cli.ts` does not exist.

- [ ] **Step 4: Create `src/cli.ts`**

```ts
#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseConfig, resolveProfile } from "./config";
import { OpenAIBackend } from "./backends/base";
import { resolveTools } from "./tools/registry";
import { runLoop } from "./loop";
import { buildEnvelope } from "./envelope";
import { writeTranscript } from "./transcript";

const USAGE = `subagents run --profile <name> --task <text> [options]

Options:
  --profile <name>     Profile from config. Required.
  --task <text>        What the delegate should do. Required.
  --root <dir>         Repository root the delegate is confined to. Default: cwd.
  --tier <name>        Override the profile's tier.
  --config <path>      Config file. Default: ./subagents.yaml, then
                       ~/.config/subagents/config.yaml
  --transcript <path>  Where to write the transcript. Default: a temp file.
  --deadline-secs <n>  Wall-clock budget. Set it below your shell tool's timeout:
                       the loop then stops early with status "deadline" and a
                       valid envelope, instead of being killed with no output.
  --verbose            Print per-turn progress to stderr.
`;

function findConfig(explicit?: string): string {
  if (explicit) {
    if (!existsSync(explicit)) throw new Error(`config not found: ${explicit}`);
    return explicit;
  }
  for (const candidate of [
    resolve("subagents.yaml"),
    join(homedir(), ".config", "subagents", "config.yaml"),
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(
    "no config found. Looked for ./subagents.yaml and " +
      "~/.config/subagents/config.yaml. Copy subagents.example.yaml to start.",
  );
}

async function main(argv: string[]): Promise<number> {
  const command = argv[0];
  if (!command || command === "--help" || command === "-h") {
    process.stdout.write(USAGE);
    return command ? 0 : 1;
  }
  if (command !== "run") {
    process.stderr.write(`unknown command '${command}'\n\n${USAGE}`);
    return 1;
  }

  const { values } = parseArgs({
    args: argv.slice(1),
    options: {
      profile: { type: "string" },
      task: { type: "string" },
      root: { type: "string" },
      tier: { type: "string" },
      config: { type: "string" },
      transcript: { type: "string" },
      "deadline-secs": { type: "string" },
      verbose: { type: "boolean", default: false },
    },
    allowPositionals: false,
  });

  for (const required of ["profile", "task"] as const) {
    if (!values[required]) {
      process.stderr.write(`missing required --${required}\n\n${USAGE}`);
      return 1;
    }
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

  const cfg = parseConfig(await Bun.file(findConfig(values.config)).text());
  const run = resolveProfile(cfg, values.profile!, { tier: values.tier });
  const root = resolve(values.root ?? process.cwd());
  if (!existsSync(root)) throw new Error(`root does not exist: ${root}`);

  const transcriptPath = values.transcript
    ?? join(process.env["TMPDIR"] ?? "/tmp", `subagents-${Date.now()}.json`);
  mkdirSync(resolve(transcriptPath, ".."), { recursive: true });

  const started = Date.now();
  const result = await runLoop({
    backend: new OpenAIBackend(run.baseUrl, process.env["SUBAGENTS_API_KEY"]),
    model: run.model,
    tools: resolveTools(run.tools),
    task: values.task!,
    maxTurns: run.maxTurns,
    maxTokens: run.maxTokens,
    sampling: run.sampling,
    timeoutMs: run.timeoutMs,
    root,
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

  await writeTranscript(transcriptPath, {
    model: run.model,
    task: values.task!,
    status: result.status,
    messages: result.messages,
    usage: result.usage,
  });

  const envelope = buildEnvelope(result, {
    wallSecs: (Date.now() - started) / 1000,
    transcript: transcriptPath,
    contextLimit: null,
  });
  process.stdout.write(`${JSON.stringify(envelope, null, 1)}\n`);
  return result.status === "ok" ? 0 : 2;
}

try {
  process.exit(await main(process.argv.slice(2)));
} catch (e) {
  process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `bun test tests/cli.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 6: Run the whole suite and typecheck**

Run: `bun test && bun run typecheck`
Expected: every test passes and typecheck is silent. Report the actual test count rather than matching a number stated here — a count written in advance drifts as tasks are amended.

- [ ] **Step 7: Verify against a real model**

Requires a running OpenAI-compatible server with a tool-capable model.

Run:
```bash
cp subagents.example.yaml subagents.yaml   # edit base_url and model
bun src/cli.ts run --profile digest --root . --verbose \
  --task "List every exported function in src/tools/, with file and line number."
```
Expected: `status: "ok"`, per-turn progress on stderr, an envelope on stdout, and line numbers that match `grep -n "^export function" src/tools/*.ts`.

- [ ] **Step 8: Commit**

```bash
git add src/cli.ts subagents.example.yaml tests/cli.test.ts
git commit -m "feat: subagents run, end to end

Exit codes distinguish the three outcomes a caller acts on differently:
0 completed, 2 ran but did not finish cleanly, 1 could not run at all."
```

---

## Follow-on plans

Each produces working software on its own and depends only on this plan:

1. **Write support** — `edit_file`, `write_file`, `bash`; git worktree isolation; test gate with revert-on-fail; `files_changed`, `diffstat` and `test` in the envelope.
2. **LM Studio backend** — `subagents models` capability listing via `/api/v0/models`, residency and TTL control through `lms`, device-federation warnings, and a real `contextLimit` for envelope pressure (currently hardcoded `null`).
3. **MCP client** — Streamable-HTTP client, per-tool allowlist with forced caps, `tools_omitted` in the envelope when a server is unreachable.
4. **Benchmark harness** — fixtures pairing a task with a deterministic oracle; scores recall, precision, citation accuracy, fabrication count, turns, wall time, tokens.

## Self-Review

**Spec coverage.** Config with providers/tiers/sampling/profiles → Task 1. OpenAI-compatible floor → Task 2. Claude-Code-faithful read semantics → Task 3. Deterministic search → Task 4. Loop with correct termination → Task 5. Envelope with truncation and pressure, full-message transcript → Task 6. CLI → Task 7. Design items deliberately deferred to follow-on plans: write tools, worktree and test gate, LM Studio adapter, MCP client, benchmark harness. Design items **not** covered anywhere and accepted as gaps for now: `context.limit` is `null` until the LM Studio backend lands, so `pressure` is null in practice; `tools_omitted` is absent from the envelope until the MCP client exists.

**Placeholder scan.** No TBDs. Every code step carries complete, runnable code. Every test step carries real assertions. No "similar to Task N" references.

**Type consistency.** `ToolResult {content, truncated}` is produced in Task 3 and consumed unchanged in Tasks 4 and 5. `Tool.run(args, ctx)` signature matches across `read.ts`, `search.ts`, the loop's `dispatch`, and the fakes in `loop.test.ts`. `LoopResult` fields produced in Task 5 are exactly those consumed by `buildEnvelope` and `writeTranscript` in Task 6. `ResolvedRun` fields from Task 1 map one-to-one onto `runLoop` arguments in Task 7. `Usage` uses optional `prompt_tokens`/`completion_tokens` throughout, and every read site defaults with `?? 0`.
