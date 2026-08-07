import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Tool, ToolContext, ToolResult } from "./types";
import { safeWritePath } from "./paths";
import { toLines } from "./read";
import { syntaxNote } from "./syntax";

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
      content: `Wrote ${rel} (${lines} line${lines === 1 ? "" : "s"}).${syntaxNote(path, content)}`,
      truncated: false,
    };
  },
};
