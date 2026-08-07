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
  onEvent?: (e: TurnEvent) => void;
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

export interface ToolCallEvent {
  name: string;
  argsChars: number;
  resultChars: number;
  truncated: boolean;
}

export interface TurnEvent {
  turn: number;
  /** Full turn: backend round trip plus every tool dispatched. */
  latencyMs: number;
  backendMs: number;
  toolCalls: ToolCallEvent[];
  promptTokens?: number;
  completionTokens?: number;
  finishReason?: string;
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

// Appended only when the profile has write tools — read-only runs must not
// pay for it every turn (prompt economy).
export const WRITE_SYSTEM_PROMPT_SUFFIX =
  "\nread_file a file before editing it. Make the smallest change that satisfies the task.";

/** Observers are advisory: a throwing callback must never cost the caller its result. */
function emitTurn(o: LoopOptions, e: TurnEvent): void {
  try { o.onEvent?.(e); } catch { /* swallowed deliberately */ }
  try { o.onTurn?.(e.turn, e.latencyMs / 1000, e.toolCalls.map((t) => t.name)); } catch { /* ditto */ }
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
 * - `type: "function"` is set unconditionally. The wire's own value is
 *   irrelevant (it can only ever be "function"), but its *absence* is not:
 *   LM Studio validates the echoed assistant message and rejects a
 *   tool_call without `type` as HTTP 400 "Invalid 'messages'" — found
 *   against a live server; every scripted test fake accepted it.
 */
function normalizeToolCall(raw: WireToolCall, turn: number, index: number): ToolCall {
  const id = typeof raw?.id === "string" && raw.id.length > 0
    ? raw.id
    : `missing-id-turn${turn}-${index}`;
  const name = typeof raw?.function?.name === "string" ? raw.function.name : "";
  const args = typeof raw?.function?.arguments === "string" ? raw.function.arguments : "";
  return { id, type: "function", function: { name, arguments: args } };
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

  // Diagnosis state for the empty-final-turn error below. A model that
  // already called tools demonstrably can call tools, so an empty turn after
  // real tool use is the model giving up on the task, not a capability gap
  // (observed live 2026-08-07: gemma-4-e2b called tools for 10 turns, then
  // emitted an empty stop turn after repeated edit failures).
  let anyToolCalls = false;
  let trailingFailedCalls = 0;

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
    const backendMs = Date.now() - started;

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

    if (choice.finish_reason === "length") {
      worstTurnMs = Math.max(worstTurnMs, Date.now() - started);
      emitTurn(o, {
        turn: turns,
        latencyMs: Date.now() - started,
        backendMs,
        toolCalls: [],
        promptTokens: res.usage?.prompt_tokens,
        completionTokens: res.usage?.completion_tokens,
        finishReason: choice.finish_reason,
      });
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
      emitTurn(o, {
        turn: turns,
        latencyMs: Date.now() - started,
        backendMs,
        toolCalls: [],
        promptTokens: res.usage?.prompt_tokens,
        completionTokens: res.usage?.completion_tokens,
        finishReason: choice.finish_reason,
      });
      const text = msg.content ?? "";
      messages.push({ role: "assistant", content: text });
      if (!text) {
        // An empty turn is still an error either way — reporting it as `ok`
        // would hide the problem behind a silently "successful" answer — but
        // the diagnosis depends on history. With no tool call ever, this is
        // exactly the shape a model that cannot call tools produces. After
        // real tool use, capability is proven and the model gave up instead.
        if (anyToolCalls) {
          const failedNote = trailingFailedCalls > 0
            ? ` (last ${trailingFailedCalls} tool attempt${trailingFailedCalls === 1 ? "" : "s"} failed)`
            : "";
          return done(
            "error", "",
            `model '${o.model}' stopped emitting after ${turns} turns${failedNote} — ` +
              "likely task difficulty, not a tool-use capability problem; consider " +
              "escalating to a stronger tier.",
          );
        }
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

    anyToolCalls = true;
    const toolEvents: ToolCallEvent[] = [];
    for (const call of calls) {
      const r = await dispatch(call.function.name, call.function.arguments, byName, o, session);
      if (r.truncated) truncations++;
      // `ERROR:` is dispatch's own failure prefix (unknown tool, bad JSON,
      // tool throw) — a heuristic, since nothing stops a tool's real output
      // from starting with it, but it only shades the diagnosis wording.
      if (r.content.startsWith("ERROR:")) trailingFailedCalls++;
      else trailingFailedCalls = 0;
      toolEvents.push({
        name: call.function.name,
        argsChars: call.function.arguments.length,
        resultChars: r.content.length,
        truncated: r.truncated,
      });
      messages.push({ role: "tool", tool_call_id: call.id, content: r.content });
    }

    // The full iteration cost — backend latency plus every tool call just
    // dispatched — is what the next turn's gate needs, not just the chat
    // round trip measured above.
    worstTurnMs = Math.max(worstTurnMs, Date.now() - started);
    emitTurn(o, {
      turn: turns,
      latencyMs: Date.now() - started,
      backendMs,
      toolCalls: toolEvents,
      promptTokens: res.usage?.prompt_tokens,
      completionTokens: res.usage?.completion_tokens,
      finishReason: choice.finish_reason,
    });
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
): Promise<{ content: string; truncated: boolean }> {
  const tool = byName.get(name);
  if (!tool) {
    return {
      content: `ERROR: unknown tool '${name}'. Available: ${[...byName.keys()].join(", ") || "(none)"}`,
      truncated: false,
    };
  }
  let args: Record<string, unknown>;
  try {
    args = JSON.parse(rawArgs || "{}") as Record<string, unknown>;
  } catch (e) {
    return {
      content: `ERROR: arguments were not valid JSON (${
        e instanceof Error ? e.message : String(e)
      }). Retry this call with valid JSON.`,
      truncated: false,
    };
  }
  try {
    const result = await tool.run(args, { root: o.root, session });
    return { content: result.content, truncated: result.truncated };
  } catch (e) {
    return { content: `ERROR: ${e instanceof Error ? e.message : String(e)}`, truncated: false };
  }
}
