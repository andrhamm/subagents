import { join } from "node:path";
import { Glob } from "bun";
import type { Tool, ToolResult, ToolContext } from "./types";
import { safePath } from "./paths";

export const MAX_MATCHES = 300;
export const MAX_FILES = 200;
const MAX_LINE = 200;

const SKIP_DIRS = new Set([".git", "node_modules", "dist", "build", ".next", "coverage"]);

/** The first path segment that names an excluded directory, if any. */
function excludedBy(rel: string): string | undefined {
  return rel.split("/").find((seg) => SKIP_DIRS.has(seg));
}

/**
 * Everything a search silently left out, so it can be surfaced instead.
 * Never truncate silently applies to all four: the match/file cap (handled by
 * `capped`), directories skipped by name, lines cut at MAX_LINE, and files
 * that could not be read.
 */
interface Omissions {
  excludedCount: number;
  excludedNames: Set<string>;
  unreadable: number;
  lineCut: boolean;
}

function newOmissions(): Omissions {
  return { excludedCount: 0, excludedNames: new Set(), unreadable: 0, lineCut: false };
}

async function* walk(root: string, pattern: string, omit: Omissions): AsyncGenerator<string> {
  const g = new Glob(pattern);
  for await (const rel of g.scan({ cwd: root, onlyFiles: true, dot: false })) {
    const seg = excludedBy(rel);
    if (seg) {
      omit.excludedCount++;
      omit.excludedNames.add(seg);
      continue;
    }
    yield rel;
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

/**
 * Append markers for excluded directories and unreadable files, and flip
 * `truncated` when those or a cut match line occurred — only when they did,
 * so the normal case pays nothing extra.
 */
function withOmissions(result: ToolResult, omit: Omissions): ToolResult {
  const notes: string[] = [];
  if (omit.excludedCount > 0) {
    const names = [...omit.excludedNames].sort().join(", ");
    const noun = omit.excludedCount === 1 ? "path" : "paths";
    notes.push(
      `[EXCLUDED: ${omit.excludedCount} ${noun} under ${names} — not enumerated. ` +
        "read_file reads these by path directly.]",
    );
  }
  if (omit.unreadable > 0) {
    const noun = omit.unreadable === 1 ? "file" : "files";
    notes.push(`[${omit.unreadable} ${noun} unreadable, not searched.]`);
  }
  if (notes.length === 0 && !omit.lineCut) return result;
  return {
    content: notes.length === 0 ? result.content : `${result.content}\n${notes.join("\n")}`,
    truncated: true,
  };
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
    const omit = newOmissions();

    for await (const rel of walk(ctx.root, filter, omit)) {
      let text: string;
      try {
        text = await Bun.file(join(ctx.root, rel)).text();
      } catch {
        omit.unreadable++;
        continue;
      }
      const lines = text.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? "";
        if (!rx.test(line)) continue;
        total++;
        if (shown.length < MAX_MATCHES) {
          if (line.length > MAX_LINE) {
            omit.lineCut = true;
            shown.push(
              `${rel}:${i + 1}:${line.slice(0, MAX_LINE)}…[+${line.length - MAX_LINE} chars]`,
            );
          } else {
            shown.push(`${rel}:${i + 1}:${line}`);
          }
        }
      }
    }
    return withOmissions(capped(shown, total, "matches", "Narrow the pattern or glob."), omit);
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
    const omit = newOmissions();
    for await (const rel of walk(ctx.root, String(args["pattern"]), omit)) {
      total++;
      if (found.length < MAX_FILES) found.push(rel);
    }
    return withOmissions(capped(found.sort(), total, "matches", "Narrow the pattern."), omit);
  },
};

/** Strip a leading "./" and trailing slash; "." and "" both mean the root. */
function normalizeRelPath(p: string): string {
  const cleaned = p.replace(/^(\.\/)+/, "").replace(/\/+$/, "");
  return cleaned === "." ? "" : cleaned;
}

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
    const rawPath = String(args["path"]);
    const dir = safePath(ctx.root, rawPath);
    const base = normalizeRelPath(rawPath);

    // An exclude excludes: no override for a directory reached by request
    // rather than by traversal. read_file already covers reading one file
    // inside it directly.
    const baseExcludedBy = excludedBy(base);
    if (baseExcludedBy) {
      return {
        content:
          `[EXCLUDED: '${base}' matches excluded name '${baseExcludedBy}' — not enumerated. ` +
          "Use read_file to read specific files inside it by path.]",
        truncated: true,
      };
    }

    const omit = newOmissions();
    const found: string[] = [];
    let total = 0;
    const g = new Glob("**/*");
    for await (const rel of g.scan({ cwd: dir, onlyFiles: true, dot: false })) {
      // Judge exclusion by the path relative to root, not to `dir` — the
      // same directory must read the same way regardless of how it's reached.
      const seg = excludedBy(base ? `${base}/${rel}` : rel);
      if (seg) {
        omit.excludedCount++;
        omit.excludedNames.add(seg);
        continue;
      }
      total++;
      if (found.length < MAX_FILES) found.push(rel);
    }
    return withOmissions(
      capped(found.sort(), total, "files", "List a subdirectory instead."),
      omit,
    );
  },
};
