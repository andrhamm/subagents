import { describe, it, expect } from "bun:test";
import type { Backend, ChatRequest, ChatResponse } from "../src/types";
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
    // Budget was ~4s after reserve, far below the configured 300s.
    expect(backend.timeouts[0]!).toBeLessThan(5_000);
    expect(backend.timeouts[0]!).toBeGreaterThan(0);
  });

  it("never clamps the request timeout below a usable floor", async () => {
    const backend = new SlowBackend(1);
    await runLoop({
      ...base, backend, maxTurns: 1, timeoutMs: 300_000,
      tools: [fakeTool("t", { content: "x", truncated: false })],
      deadlineAt: Date.now() + 1_100,
      wrapupReserveMs: 1_000,
    });
    expect(backend.timeouts[0]!).toBeGreaterThanOrEqual(1_000);
  });

  it("runs to normal completion when no deadline is given", async () => {
    const backend = new ScriptedBackend([assistant("done")]);
    const r = await runLoop({ ...base, backend, tools: [] });
    expect(r.status).toBe("ok");
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
});
