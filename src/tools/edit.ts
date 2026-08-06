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
