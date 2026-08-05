import { describe, it, expect } from "bun:test";
import type { Backend, ChatRequest, ChatResponse, Message } from "../src/types";
import type { Tool, ToolResult } from "../src/tools/types";
import { runLoop } from "../src/loop";
import { resolveTools } from "../src/tools/registry";

/** Backend that replays scripted responses and records what it was sent. */
class ScriptedBackend implements Backend {
  public seen: ChatRequest[] = [];
  constructor(private script: Array<ChatResponse | Error>) {}
  async chat(req: ChatRequest): Promise<ChatResponse> {
    this.seen.push(structuredClone(req));
    const next = this.script.shift();
    if (!next) throw new Error("script exhausted");
    if (next instanceof Error) throw next;
    return next;
  }
}

/**
 * Enforces the wire protocol from the backend's side: every `tool_call.id`
 * this backend issues in an assistant message must come back as a `tool`
 * message with a matching `tool_call_id` on the very next request, or it
 * throws. `ScriptedBackend` above only replays canned responses without
 * checking conformance — which is exactly how a dropped or malformed
 * `tool_call_id` could survive 82 passing tests undetected.
 */
class ProtocolValidatingBackend implements Backend {
  public seen: ChatRequest[] = [];
  private pendingIds = new Set<string>();
  constructor(private script: ChatResponse[]) {}

  async chat(req: ChatRequest): Promise<ChatResponse> {
    this.seen.push(structuredClone(req));

    const toolMsgs = req.messages.filter(
      (m): m is Extract<Message, { role: "tool" }> => m.role === "tool");
    // Catches the defect directly: a dropped/undefined tool_call_id is a
    // protocol violation regardless of whether it happens to match a
    // pending id below.
    for (const m of toolMsgs) {
      if (typeof m.tool_call_id !== "string" || m.tool_call_id.length === 0) {
        throw new Error(
          `protocol violation: a tool message has no usable tool_call_id ` +
            `(${JSON.stringify(m.tool_call_id)})`,
        );
      }
    }
    if (this.pendingIds.size > 0) {
      const answered = new Set(toolMsgs.map((m) => m.tool_call_id));
      for (const id of this.pendingIds) {
        if (!answered.has(id)) {
          throw new Error(
            `protocol violation: tool_call_id '${id}' was never answered by a tool message`,
          );
        }
      }
      this.pendingIds.clear();
    }

    const next = this.script.shift();
    if (!next) throw new Error("script exhausted");
    for (const c of next.choices?.[0]?.message?.tool_calls ?? []) {
      if (c.id) this.pendingIds.add(c.id);
    }
    return next;
  }
}

const assistant = (content: string | null, calls?: Array<[string, string, string]>) =>
  ({
    choices: [{
      message: {
        role: "assistant" as const,
        content,
        ...(calls
          ? { tool_calls: calls.map(([id, name, args]) => ({ id, function: { name, arguments: args } })) }
          : {}),
      },
      finish_reason: calls ? "tool_calls" : "stop",
    }],
    usage: { prompt_tokens: 100, completion_tokens: 10 },
  }) satisfies ChatResponse;

function fakeTool(name: string, result: ToolResult | Error): Tool {
  return {
    name,
    schema: {
      type: "function",
      function: { name, description: "d", parameters: { type: "object", properties: {} } },
    },
    async run() {
      if (result instanceof Error) throw result;
      return result;
    },
  };
}

const base = {
  model: "m",
  task: "do the thing",
  maxTurns: 10,
  maxTokens: 1000,
  sampling: {},
  timeoutMs: 5000,
  root: process.cwd(),
};

describe("resolveTools", () => {
  it("does not resolve inherited Object.prototype properties as tools", () => {
    expect(() => resolveTools(["toString"])).toThrow(/unknown tool/);
  });
});

describe("runLoop termination", () => {
  it("treats content with no tool calls as completion", async () => {
    const backend = new ScriptedBackend([assistant("here is the answer")]);
    const r = await runLoop({ ...base, backend, tools: [] });
    expect(r.status).toBe("ok");
    expect(r.summary).toBe("here is the answer");
    expect(r.turns).toBe(1);
  });

  it("never requires a terminator tool to be offered", async () => {
    const backend = new ScriptedBackend([assistant("done")]);
    const r = await runLoop({ ...base, backend, tools: resolveTools(["read_file"]) });
    const names = backend.seen[0]!.tools!.map((t) => t.function.name);
    expect(names).toEqual(["read_file"]);
    expect(r.status).toBe("ok");
  });

  it("reports budget exhaustion from finish_reason=length", async () => {
    const backend = new ScriptedBackend([{
      choices: [{ message: { role: "assistant", content: "half an ans" }, finish_reason: "length" }],
    }]);
    const r = await runLoop({ ...base, backend, tools: [] });
    expect(r.status).toBe("budget");
    expect(r.detail).toContain("finish_reason=length");
  });

  it("stops at maxTurns and keeps the last assistant text", async () => {
    const call = assistant("thinking", [["1", "t", "{}"]]);
    const backend = new ScriptedBackend([call, call, call]);
    const r = await runLoop({
      ...base, backend, maxTurns: 2,
      tools: [fakeTool("t", { content: "ok", truncated: false })],
    });
    expect(r.status).toBe("max_turns");
    expect(r.turns).toBe(2);
    expect(r.summary).toBe("thinking");
  });
});

describe("runLoop tool dispatch", () => {
  it("executes a tool and feeds the result back as a tool message", async () => {
    const backend = new ScriptedBackend([
      assistant(null, [["c1", "t", '{"a":1}']]),
      assistant("finished"),
    ]);
    const r = await runLoop({
      ...base, backend, tools: [fakeTool("t", { content: "TOOL OUTPUT", truncated: false })],
    });
    expect(r.status).toBe("ok");
    const second = backend.seen[1]!.messages;
    const toolMsg = second.find((m) => m.role === "tool") as { content: string } | undefined;
    expect(toolMsg?.content).toBe("TOOL OUTPUT");
  });

  it("counts truncated tool results", async () => {
    const backend = new ScriptedBackend([
      assistant(null, [["c1", "t", "{}"]]),
      assistant("done"),
    ]);
    const r = await runLoop({
      ...base, backend, tools: [fakeTool("t", { content: "partial", truncated: true })],
    });
    expect(r.truncations).toBe(1);
  });

  it("feeds an unknown tool name back as an error and continues", async () => {
    const backend = new ScriptedBackend([
      assistant(null, [["c1", "ghost", "{}"]]),
      assistant("recovered"),
    ]);
    const r = await runLoop({ ...base, backend, tools: [] });
    expect(r.status).toBe("ok");
    const msg = backend.seen[1]!.messages.find((m) => m.role === "tool") as { content: string };
    expect(msg.content).toContain("unknown tool 'ghost'");
  });

  it("feeds malformed tool arguments back as an error and continues", async () => {
    const backend = new ScriptedBackend([
      assistant(null, [["c1", "t", "{not json"]]),
      assistant("recovered"),
    ]);
    const r = await runLoop({
      ...base, backend, tools: [fakeTool("t", { content: "unused", truncated: false })],
    });
    expect(r.status).toBe("ok");
    const msg = backend.seen[1]!.messages.find((m) => m.role === "tool") as { content: string };
    expect(msg.content).toContain("not valid JSON");
  });

  it("feeds a throwing tool back as an error and continues", async () => {
    const backend = new ScriptedBackend([
      assistant(null, [["c1", "t", "{}"]]),
      assistant("recovered"),
    ]);
    const r = await runLoop({
      ...base, backend, tools: [fakeTool("t", new Error("path escapes root: ../x"))],
    });
    expect(r.status).toBe("ok");
    const msg = backend.seen[1]!.messages.find((m) => m.role === "tool") as { content: string };
    expect(msg.content).toContain("path escapes root");
  });

  it("runs every tool call in a multi-call turn", async () => {
    const backend = new ScriptedBackend([
      assistant(null, [["c1", "t", "{}"], ["c2", "t", "{}"], ["c3", "t", "{}"]]),
      assistant("done"),
    ]);
    await runLoop({
      ...base, backend, tools: [fakeTool("t", { content: "x", truncated: false })],
    });
    const toolMsgs = backend.seen[1]!.messages.filter((m) => m.role === "tool");
    expect(toolMsgs).toHaveLength(3);
  });
});

describe("runLoop deadline", () => {
  /** Backend whose every reply takes `delayMs`, so turn duration is controllable. */
  class SlowBackend implements Backend {
    public calls = 0;
    public timeouts: number[] = [];
    constructor(private delayMs: number) {}
    async chat(_req: ChatRequest, timeoutMs: number): Promise<ChatResponse> {
      this.calls++;
      this.timeouts.push(timeoutMs);
      await Bun.sleep(this.delayMs);
      return assistant(`turn ${this.calls}`, [["c", "t", "{}"]]);
    }
  }

  it("stops with status deadline rather than starting a turn it cannot finish", async () => {
    const backend = new SlowBackend(120);
    const r = await runLoop({
      ...base, backend, maxTurns: 50,
      tools: [fakeTool("t", { content: "x", truncated: false })],
      deadlineAt: Date.now() + 400,
      wrapupReserveMs: 50,
    });
    expect(r.status).toBe("deadline");
    // Ran at least once, but nowhere near maxTurns.
    expect(r.turns).toBeGreaterThan(0);
    expect(r.turns).toBeLessThan(10);
    expect(r.detail).toMatch(/worst observed turn|deadline reached/);
  });

  it("keeps the last assistant text as the partial summary", async () => {
    const backend = new SlowBackend(120);
    const r = await runLoop({
      ...base, backend, maxTurns: 50,
      tools: [fakeTool("t", { content: "x", truncated: false })],
      deadlineAt: Date.now() + 400,
      wrapupReserveMs: 50,
    });
    expect(r.summary).toMatch(/^turn \d+$/);
  });

  it("stops immediately when the deadline has already passed", async () => {
    const backend = new SlowBackend(10);
    const r = await runLoop({
      ...base, backend, tools: [],
      deadlineAt: Date.now() - 1,
      wrapupReserveMs: 50,
    });
    expect(r.status).toBe("deadline");
    expect(r.turns).toBe(0);
    expect(backend.calls).toBe(0);
    expect(r.detail).toContain("deadline reached before turn 1");
  });

  it("clamps the per-request timeout to the remaining budget", async () => {
    const backend = new SlowBackend(10);
    await runLoop({
      ...base, backend, maxTurns: 1, timeoutMs: 300_000,
      tools: [fakeTool("t", { content: "x", truncated: false })],
      deadlineAt: Date.now() + 5_000,
      wrapupReserveMs: 1_000,
    });
    // Budget was ~4s after reserve, far below the configured 300s. Banded
    // tightly: a clamp that ignored `reserve` entirely would land near 5s
    // and slip past a loose upper bound.
    expect(backend.timeouts[0]!).toBeGreaterThan(3_500);
    expect(backend.timeouts[0]!).toBeLessThanOrEqual(4_000);
  });

  it("never clamps the request timeout below a usable floor", async () => {
    const backend = new SlowBackend(1);
    await runLoop({
      ...base, backend, maxTurns: 1, timeoutMs: 300_000,
      tools: [fakeTool("t", { content: "x", truncated: false })],
      // 900ms of headroom after the 1s reserve — below the floor, so this
      // exercises the clamp without leaving so little time that the gate
      // refuses the turn outright (which would never call chat at all).
      deadlineAt: Date.now() + 1_900,
      wrapupReserveMs: 1_000,
    });
    expect(backend.timeouts[0]!).toBeGreaterThanOrEqual(1_000);
  });

  it("runs to normal completion when no deadline is given", async () => {
    const backend = new ScriptedBackend([assistant("done")]);
    const r = await runLoop({ ...base, backend, tools: [] });
    expect(r.status).toBe("ok");
  });

  it("counts tool execution time toward the worst observed turn, not just backend latency", async () => {
    /** Replies instantly — every turn's real cost is the tool below, not the backend. */
    class InstantBackend implements Backend {
      public calls = 0;
      async chat(): Promise<ChatResponse> {
        this.calls++;
        return assistant(`turn ${this.calls}`, [["c", "t", "{}"]]);
      }
    }
    const slowTool: Tool = {
      name: "t",
      schema: {
        type: "function",
        function: { name: "t", description: "d", parameters: { type: "object", properties: {} } },
      },
      async run() {
        await Bun.sleep(150);
        return { content: "x", truncated: false };
      },
    };
    const backend = new InstantBackend();
    const r = await runLoop({
      ...base, backend, maxTurns: 50,
      tools: [slowTool],
      deadlineAt: Date.now() + 300,
      wrapupReserveMs: 50,
    });
    expect(r.status).toBe("deadline");
    // A gate that measured only backend latency (near-zero here) would see
    // no reason to refuse a second turn, since it never learns that the
    // *tool* took 150ms. It would proceed, and only notice the deadline
    // after two turns' worth of tool time had already elapsed. A gate that
    // counts the full turn refuses before starting turn 2.
    expect(r.turns).toBe(1);
  });
});

describe("runLoop errors", () => {
  it("returns error status when the backend throws", async () => {
    const backend = new ScriptedBackend([new Error("connection refused")]);
    const r = await runLoop({ ...base, backend, tools: [] });
    expect(r.status).toBe("error");
    expect(r.detail).toContain("connection refused");
  });

  it("returns error status when the response has no choices", async () => {
    const backend = new ScriptedBackend([{ choices: [] }]);
    const r = await runLoop({ ...base, backend, tools: [] });
    expect(r.status).toBe("error");
    expect(r.detail).toContain("no choices");
  });

  it("returns error status, not a rejected promise, when a choice has no message", async () => {
    // Shapes a real server could send: a truncated/streaming-style choice
    // with no `message` field at all.
    const malformed = { choices: [{ finish_reason: "stop" }] } as unknown as ChatResponse;
    const backend = new ScriptedBackend([malformed]);
    const r = await runLoop({ ...base, backend, tools: [] });
    expect(r.status).toBe("error");
    expect(r.detail).toContain("no choices");
  });

  it("does not let a throwing onTurn callback break the run", async () => {
    const backend = new ScriptedBackend([assistant("done")]);
    const r = await runLoop({
      ...base, backend, tools: [],
      onTurn: () => { throw new Error("EPIPE"); },
    });
    expect(r.status).toBe("ok");
    expect(r.summary).toBe("done");
  });

  it("passes sampling parameters through to the backend", async () => {
    const backend = new ScriptedBackend([assistant("done")]);
    await runLoop({
      ...base, backend, tools: [],
      sampling: { temperature: 0.3, top_p: 0.95, top_k: 64 },
    });
    expect(backend.seen[0]!.temperature).toBe(0.3);
    expect(backend.seen[0]!.top_k).toBe(64);
  });

  it("records the full message array including tool results", async () => {
    const backend = new ScriptedBackend([
      assistant(null, [["c1", "t", "{}"]]),
      assistant("done"),
    ]);
    const r = await runLoop({
      ...base, backend, tools: [fakeTool("t", { content: "seen", truncated: false })],
    });
    const roles = r.messages.map((m) => m.role);
    expect(roles).toEqual(["system", "user", "assistant", "tool", "assistant"]);
  });

  it("marks the diagnostic slice with an ellipsis when the malformed response is cut", async () => {
    // A response whose serialized form exceeds the 400-char diagnostic
    // slice must say so — otherwise a cut diagnostic reads as complete.
    const huge = {
      choices: [], extra: "x".repeat(500),
    } as unknown as ChatResponse;
    const backend = new ScriptedBackend([huge]);
    const r = await runLoop({ ...base, backend, tools: [] });
    expect(r.status).toBe("error");
    expect(r.detail).toContain("…");
  });

  it("does not add an ellipsis when the malformed response fits within the slice", async () => {
    const small = { choices: [] } as unknown as ChatResponse;
    const backend = new ScriptedBackend([small]);
    const r = await runLoop({ ...base, backend, tools: [] });
    expect(r.status).toBe("error");
    expect(r.detail).not.toContain("…");
  });
});

// Critical fix: an arbitrary HTTP server controls `tool_calls`, and nothing
// guaranteed it was a well-formed array of well-formed calls. Each shape
// below used to throw out of runLoop entirely — no envelope, no transcript,
// the delegate already paid for — instead of degrading like every other
// malformed-input path in this file already does.
describe("runLoop malformed tool_calls", () => {
  it("does not throw when tool_calls is present but not an array", async () => {
    const malformed = {
      choices: [{
        message: { role: "assistant", content: null, tool_calls: {} },
        finish_reason: "tool_calls",
      }],
    } as unknown as ChatResponse;
    const backend = new ScriptedBackend([malformed]);
    const r = await runLoop({ ...base, backend, tools: [] });
    // Non-array tool_calls degrades to "no calls"; combined with no content
    // that is the capability-failure shape (see the gate below), not a crash.
    expect(r.status).toBe("error");
    expect(r.turns).toBe(1);
  });

  it("does not throw when a call is missing its function, and degrades to an unknown-tool error", async () => {
    const backend = new ScriptedBackend([
      {
        choices: [{
          message: { role: "assistant", content: null, tool_calls: [{ id: "c1" }] },
          finish_reason: "tool_calls",
        }],
      } as unknown as ChatResponse,
      assistant("recovered"),
    ]);
    const r = await runLoop({ ...base, backend, tools: [] });
    expect(r.status).toBe("ok");
    const msg = backend.seen[1]!.messages.find((m) => m.role === "tool") as { content: string };
    expect(msg.content).toContain("unknown tool");
  });

  it("does not throw and synthesizes a stable id when a call is missing its id", async () => {
    const backend = new ScriptedBackend([
      {
        choices: [{
          message: {
            role: "assistant", content: null,
            tool_calls: [{ function: { name: "t", arguments: "{}" } }],
          },
          finish_reason: "tool_calls",
        }],
      } as unknown as ChatResponse,
      assistant("recovered"),
    ]);
    const r = await runLoop({
      ...base, backend, tools: [fakeTool("t", { content: "x", truncated: false })],
    });
    expect(r.status).toBe("ok");
    const toolMsg = backend.seen[1]!.messages.find((m) => m.role === "tool") as
      { tool_call_id: string; content: string };
    // A missing id must never surface as `undefined` — that value drops out
    // of JSON.stringify and 400s the next real request.
    expect(typeof toolMsg.tool_call_id).toBe("string");
    expect(toolMsg.tool_call_id.length).toBeGreaterThan(0);
    expect(toolMsg.content).toBe("x");
  });
});

// A response with no tool calls and no content is exactly the shape a model
// that cannot call tools produces. Reporting it as a normal `ok` completion
// (empty summary, empty detail) hides a capability problem as if it were a
// correct but silent answer.
describe("runLoop capability gate", () => {
  it("reports a capability problem, not false success, when a turn has no calls and no content", async () => {
    const backend = new ScriptedBackend([assistant(null)]);
    const r = await runLoop({ ...base, model: "some-incapable-model", backend, tools: [] });
    expect(r.status).toBe("error");
    expect(r.detail).toContain("some-incapable-model");
  });

  it("still reports ok when content is present alongside no tool calls", async () => {
    const backend = new ScriptedBackend([assistant("a real answer")]);
    const r = await runLoop({ ...base, backend, tools: [] });
    expect(r.status).toBe("ok");
    expect(r.summary).toBe("a real answer");
  });
});

describe("runLoop protocol conformance", () => {
  it("answers every issued tool_call_id, including a synthesized fallback for malformed calls", async () => {
    const backend = new ProtocolValidatingBackend([
      // Malformed: a call with an id but no `function` at all — the shape
      // that used to throw at `c.function.name`.
      {
        choices: [{
          message: { role: "assistant", content: null, tool_calls: [{ id: "c1" }] },
          finish_reason: "tool_calls",
        }],
      } as unknown as ChatResponse,
      // Malformed: a call with no id at all — the shape whose dropped
      // tool_call_id used to 400 the next request.
      {
        choices: [{
          message: {
            role: "assistant", content: null,
            tool_calls: [{ function: { name: "t", arguments: "{}" } }],
          },
          finish_reason: "tool_calls",
        }],
      } as unknown as ChatResponse,
      assistant("done"),
    ]);
    const r = await runLoop({
      ...base, backend, tools: [fakeTool("t", { content: "x", truncated: false })],
    });
    expect(r.status).toBe("ok");
    expect(backend.seen).toHaveLength(3);
  });
});
