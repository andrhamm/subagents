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

/** Resolve an allowlist of tool names, failing loudly on a typo. */
export function resolveTools(names: string[]): Tool[] {
  const out: Tool[] = [];
  const unknown: string[] = [];
  for (const name of names) {
    // A plain `ALL_TOOLS[name]` lookup also resolves inherited
    // Object.prototype properties (e.g. "toString"), which are truthy but
    // not tools. `hasOwn` restricts the lookup to keys actually assigned above.
    if (Object.hasOwn(ALL_TOOLS, name)) out.push(ALL_TOOLS[name]!);
    else unknown.push(name);
  }
  if (unknown.length) {
    throw new Error(
      `unknown tool(s): ${unknown.join(", ")}. available: ${Object.keys(ALL_TOOLS).join(", ")}`,
    );
  }
  return out;
}
