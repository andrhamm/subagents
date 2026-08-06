import type {
  AssistantMessage, Backend, ChatResponse, Message, SamplingParams, ToolCall, Usage,
  WireToolCall,
} from "./types";
import { newSession, type RunSession, type Tool } from "./tools/types";
import { markIfCut } from "./text";

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

/** A broken progress callback (e.g. EPIPE from a closed pipe) must not cost the caller its result. */
function safeOnTurn(o: LoopOptions, turn: number, elapsedMs: number, toolNames: string[]): void {
  try {
    o.onTurn?.(turn, elapsedMs / 1000, toolNames);
  } catch {
    // swallowed deliberately
  }
}

/**
 * A tool call as sent over the wire is fully untrustworthy — an arbitrary
 * HTTP server controls it, and nothing guarantees `function` or `id` are
 * present or well-typed. Normalize each into the strict `ToolCall` shape our
 * own message history requires, degrading a malformed field instead of
 * letting it crash the loop:
 *
 * - A missing/non-string `id` gets a synthesized fallback. Left as
 *   `undefined`, it would drop out of `JSON.stringify` on the next request
 *   and 400 it — silently corrupting every turn after this one.
 * - A missing/non-string tool name degrades to `""`, which `dispatch`
 *   already turns into a correctable `ERROR: unknown tool` message — the
 *   same path a real unknown tool name takes, not a special case.
 */
function normalizeToolCall(raw: WireToolCall, turn: number, index: number): ToolCall {
  const id = typeof raw?.id === "string" && raw.id.length > 0
    ? raw.id
    : `missing-id-turn${turn}-${index}`;
  const name = typeof raw?.function?.name === "string" ? raw.function.name : "";
  const args = typeof raw?.function?.arguments === "string" ? raw.function.arguments : "";
  return { id, function: { name, arguments: args } };
}

export async function runLoop(o: LoopOptions): Promise<LoopResult> {
  const byName = new Map(o.tools.map((t) => [t.name, t]));
  const session = newSession();
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
  /**
   * Worst full turn seen so far — backend latency plus every tool call it
   * dispatched. The tail overruns budgets, not the mean, and tool execution
   * is invisible to the caller's shell timeout exactly like backend latency
   * is: both must count, or the gate would let a turn start that a slow
   * tool call (not just a slow model) blows past the deadline.
   *
   * Residual risk, accepted rather than fixed: nothing bounds a single
   * tool call's own duration, so this can only learn from an overrun after
   * the fact, never prevent the first one. A pathological first call can
   * still run past the deadline once; after that the gate adapts.
   */
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

    let res: ChatResponse | null;
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

    // The fifth level of the same defect as malformed `choices`,
    // `choice.message`, and `call.function` below: a 200-OK body that parses
    // to JSON `null` (or any other non-object) is not a throw, it's a value
    // — `Backend.chat`'s `ChatResponse | null` return type makes the
    // compiler enforce a guard here rather than letting `res.usage` crash a
    // turn after the run already paid for it. There is nothing to append to
    // `messages` and no way to know what the server intended, so this ends
    // the run rather than retrying.
    if (res === null) {
      return done(
        "error", "",
        `backend response was not a JSON object (malformed body: null, an array, or a bare ` +
          "primitive) — the run cannot continue from an unreadable response",
      );
    }

    if (res.usage) usage.push(res.usage);

    const choice = res.choices?.[0];
    // A malformed or streaming-shaped response (finish_reason with no
    // `message`, or a `delta`-shaped choice) is treated the same as an
    // empty `choices` array: no usable answer, fail loudly rather than
    // throw and lose the run's result entirely.
    if (!choice?.message) {
      return done(
        "error", "",
        `response had no choices: ${markIfCut(JSON.stringify(res), 400)}`,
      );
    }

    const msg = choice.message;
    // `tool_calls` is server-controlled and may not even be an array (let
    // alone an array of well-formed calls) — treat anything else as none,
    // rather than crashing on `.map`/`.function.name` a turn later.
    const rawCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
    const calls = rawCalls.map((c, i) => normalizeToolCall(c, turns, i));
    const toolNames = calls.map((c) => c.function.name);

    if (choice.finish_reason === "length") {
      worstTurnMs = Math.max(worstTurnMs, Date.now() - started);
      safeOnTurn(o, turns, Date.now() - started, toolNames);
      messages.push({ role: "assistant", content: msg.content ?? "" });
      return done(
        "budget", msg.content ?? "",
        "finish_reason=length: the token budget ran out before the answer completed. " +
          "Raise max_tokens, or the loaded context window.",
      );
    }

    // Completion: the agent stopped asking for tools. No terminator tool needed.
    if (calls.length === 0) {
      worstTurnMs = Math.max(worstTurnMs, Date.now() - started);
      safeOnTurn(o, turns, Date.now() - started, toolNames);
      const text = msg.content ?? "";
      messages.push({ role: "assistant", content: text });
      if (!text) {
        // No tool calls and no content is exactly the shape a model that
        // cannot call tools produces — reporting it as `ok` would hide a
        // capability problem behind an empty, silently "successful" answer.
        return done(
          "error", "",
          `model '${o.model}' returned no tool calls and no content on turn ${turns} — ` +
            "likely cannot call tools, not a task failure. Check the model's tool-use " +
            "capability before retrying.",
        );
      }
      return done("ok", text, "");
    }

    messages.push({ role: "assistant", content: msg.content ?? "", tool_calls: calls });

    for (const call of calls) {
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: await dispatch(call.function.name, call.function.arguments, byName, o,
          session, () => { truncations++; }),
      });
    }

    // The full iteration cost — backend latency plus every tool call just
    // dispatched — is what the next turn's gate needs, not just the chat
    // round trip measured above.
    worstTurnMs = Math.max(worstTurnMs, Date.now() - started);
    safeOnTurn(o, turns, Date.now() - started, toolNames);
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
  session: RunSession,
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
    const result = await tool.run(args, { root: o.root, session });
    if (result.truncated) onTruncated();
    return result.content;
  } catch (e) {
    return `ERROR: ${e instanceof Error ? e.message : String(e)}`;
  }
}
