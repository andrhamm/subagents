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
