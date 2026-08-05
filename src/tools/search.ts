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
