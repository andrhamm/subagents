import type { Tool, ToolResult, ToolContext } from "./types";
import { safePath } from "./paths";

export const MAX_READ_LINES = 2000;

/** Split into lines without inventing a final empty line for a trailing newline. */
export function toLines(text: string): string[] {
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

    // A non-numeric offset/limit (e.g. `"all"`, `"start"`) used to coerce
    // silently to NaN: `Math.max(1, NaN)` is NaN, which then produced either
    // a self-referential TRUNCATED marker telling the model to retry from
    // the offset it was already at, or a falsely-complete empty read. Fail
    // loudly instead — `dispatch` already turns a tool throw into a
    // correctable ERROR: message, which is the right channel for a bad argument.
    //
    // `Number.isInteger`, not `Number.isFinite`: this tool's whole contract
    // is exact line numbers, and a fractional offset/limit (e.g. `1.5`)
    // still passes `isFinite`, producing fractional citations like `1.5`,
    // a nonsense "lines 1.5-3.5 of 8" range, and a TRUNCATED marker telling
    // the model to continue from a fractional offset next turn.
    const start = args["offset"] === undefined ? 1 : Number(args["offset"]);
    if (!Number.isInteger(start) || start <= 0) {
      throw new Error(
        `offset must be a positive integer, got ${JSON.stringify(args["offset"])}`,
      );
    }
    const limit = args["limit"] === undefined ? MAX_READ_LINES : Number(args["limit"]);
    if (!Number.isInteger(limit) || limit <= 0) {
      throw new Error(
        `limit must be a positive integer, got ${JSON.stringify(args["limit"])}`,
      );
    }

    // Only a read that actually returned content counts for the
    // read-before-write rule — a validation error above never reaches here.
    ctx.session?.reads.add(path);

    const window = lines.slice(start - 1, start - 1 + limit);
    const body = window
      .map((line, i) => `${String(start + i).padStart(6)}\t${line}`)
      .join("\n");

    const end = start - 1 + window.length;
    const withheld = lines.length - end;

    // window.length === 0 guards against a TRUNCATED marker ever naming an
    // empty shown range — validated offset/limit above should already make
    // that impossible, but this is the invariant the marker's honesty rests
    // on, so it stays enforced directly rather than only by construction.
    if (withheld > 0 && window.length > 0) {
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
