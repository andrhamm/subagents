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
