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
