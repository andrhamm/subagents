import { describe, it, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LoopResult } from "../src/loop";
import { buildEnvelope } from "../src/envelope";
import { writeTranscript } from "../src/transcript";

const result: LoopResult = {
  status: "ok",
  summary: "found six routes",
  detail: "",
  turns: 3,
  messages: [
    { role: "system", content: "s" },
    { role: "user", content: "u" },
    { role: "assistant", content: "a" },
  ],
  usage: [
    { prompt_tokens: 500, completion_tokens: 20 },
    { prompt_tokens: 8000, completion_tokens: 60 },
    { prompt_tokens: 21628, completion_tokens: 100 },
  ],
  truncations: 2,
};

describe("buildEnvelope", () => {
  it("reports peak prompt tokens and context pressure", () => {
    const e = buildEnvelope(result, {
      wallSecs: 12.04, transcript: "/t.json", contextLimit: 32768,
    });
    expect(e.context.peak_prompt_tokens).toBe(21628);
    expect(e.context.limit).toBe(32768);
    expect(e.context.pressure).toBe(0.66);
  });

  it("leaves pressure null when the context limit is unknown", () => {
    const e = buildEnvelope(result, {
      wallSecs: 1, transcript: "/t.json", contextLimit: null,
    });
    expect(e.context.pressure).toBeNull();
  });

  it("sums all tokens spent on the delegate", () => {
    const e = buildEnvelope(result, {
      wallSecs: 1, transcript: "/t.json", contextLimit: null,
    });
    expect(e.local_tokens).toBe(500 + 20 + 8000 + 60 + 21628 + 100);
  });

  it("carries the truncation count so blind runs are visible", () => {
    const e = buildEnvelope(result, {
      wallSecs: 1, transcript: "/t.json", contextLimit: null,
    });
    expect(e.truncations).toBe(2);
  });

  it("rounds wall seconds to one decimal", () => {
    const e = buildEnvelope(result, {
      wallSecs: 12.04, transcript: "/t.json", contextLimit: null,
    });
    expect(e.wall_secs).toBe(12);
  });

  it("omits detail when empty and includes it when set", () => {
    const ok = buildEnvelope(result, { wallSecs: 1, transcript: "/t", contextLimit: null });
    expect(ok.detail).toBeUndefined();
    const bad = buildEnvelope(
      { ...result, status: "error", detail: "connection refused" },
      { wallSecs: 1, transcript: "/t", contextLimit: null },
    );
    expect(bad.detail).toBe("connection refused");
  });

  it("stays small — the whole point of the envelope", () => {
    const e = buildEnvelope(result, { wallSecs: 1, transcript: "/t", contextLimit: 32768 });
    expect(JSON.stringify(e).length).toBeLessThan(600);
  });

  // Fix round 1: the favorable fixture above never exercises a delegate that
  // actually rambles, so it never caught an unbounded summary/detail. These
  // pathological inputs are the ones that should.
  it("stays small even when summary and detail are each thousands of characters", () => {
    const huge: LoopResult = {
      ...result,
      summary: "S".repeat(5000),
      detail: "D".repeat(5000),
    };
    const e = buildEnvelope(huge, { wallSecs: 1, transcript: "/t", contextLimit: 32768 });
    expect(JSON.stringify(e).length).toBeLessThan(600);
    // Still usable, not silently gutted to nothing.
    expect(e.summary.length).toBeGreaterThan(0);
  });

  it("stays small for loop.ts's actual 'response had no choices' error, at full length", () => {
    // Mirrors loop.ts's real construction: `response had no choices: ${JSON.stringify(res).slice(0, 400)}`.
    const fakeRes = JSON.stringify({
      choices: [],
      usage: { prompt_tokens: 12 },
      note: 'unexpected shape with "quotes" and a backslash \\ thrown in, ' + "x".repeat(400),
    });
    const stopped: LoopResult = {
      ...result,
      status: "error",
      summary: "",
      detail: `response had no choices: ${fakeRes.slice(0, 400)}`,
    };
    const e = buildEnvelope(stopped, { wallSecs: 1, transcript: "/t", contextLimit: null });
    expect(JSON.stringify(e).length).toBeLessThan(600);
    // The fallback still surfaces *why*, not just that it was cut.
    expect(e.summary).toContain("response had no choices");
  });

  // Authorized addition (beyond the brief): most delegates emit `content: null`
  // alongside tool_calls, so on a real deadline/max_turns stop `summary` is
  // usually "" — lastText() in the loop has nothing to return. Without a
  // fallback, the envelope would hand the caller nothing in exactly the case
  // early termination exists to serve: a partial result.
  it("falls back summary to detail when the run stopped before producing one", () => {
    const stopped: LoopResult = {
      ...result,
      status: "deadline",
      summary: "",
      detail: "deadline reached before turn 4; 2s left, 3s reserved to emit this envelope",
    };
    const e = buildEnvelope(stopped, { wallSecs: 1, transcript: "/t", contextLimit: null });
    // Usable information reaches the caller through the one field a naive
    // consumer reads.
    expect(e.summary).toBe(stopped.detail);
    // Not duplicated into `detail` too — that would just repeat the string
    // the envelope exists to keep small.
    expect(e.detail).toBeUndefined();
    // `status` still tells a genuine answer apart from a partial one; the
    // fallback never has to fake that distinction itself.
    expect(e.status).toBe("deadline");
  });

  it("keeps both fields when the run produced a summary and a separate detail", () => {
    // The real message loop.ts emits on finish_reason=length, verbatim.
    const detail = "finish_reason=length: the token budget ran out before the answer completed. " +
      "Raise max_tokens, or the loaded context window.";
    const e = buildEnvelope(
      { ...result, status: "budget", detail },
      { wallSecs: 1, transcript: "/t", contextLimit: null },
    );
    expect(e.summary).toBe("found six routes");
    expect(e.detail).toBe(detail);
  });
});

describe("writeTranscript", () => {
  it("persists the full message array, not just responses", async () => {
    const dir = mkdtempSync(join(tmpdir(), "subagents-tr-"));
    const path = join(dir, "t.json");
    await writeTranscript(path, {
      model: "m", task: "t", status: "ok",
      messages: result.messages, usage: result.usage,
    });
    const back = await Bun.file(path).json();
    expect(back.messages).toHaveLength(3);
    expect(back.messages[0].role).toBe("system");
    expect(back.usage).toHaveLength(3);
    rmSync(dir, { recursive: true, force: true });
  });
});
