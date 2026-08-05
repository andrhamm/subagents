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
