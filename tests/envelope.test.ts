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

  // Some proxies report usage counts as strings rather than numbers. `+`
  // on a string operand concatenates instead of adding, so an unguarded sum
  // silently produced things like "local_tokens": "01005" — a string where
  // every consumer expects a number.
  it("sums usage counts numerically even when a backend reports them as strings", () => {
    const stringy: LoopResult = {
      ...result,
      usage: [{ prompt_tokens: "500" as unknown as number, completion_tokens: "5" as unknown as number }],
    };
    const e = buildEnvelope(stringy, { wallSecs: 1, transcript: "/t.json", contextLimit: null });
    expect(e.local_tokens).toBe(505);
    expect(typeof e.local_tokens).toBe("number");
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

  // Fix round 2: round 1's shrinkField cut on raw UTF-16 code units. A cut
  // landing inside a surrogate pair (an emoji) leaves a lone surrogate,
  // which JSON.stringify re-encodes as a 6-char `\udXXX` escape — so the
  // "shrink" could make the field's encoded form *larger*. This test
  // reproduces the reviewer's rigged-boundary technique: derive the exact
  // index round 1's formula would have cut a 5000-char summary at, then
  // plant a surrogate pair straddling that index. Against round-1 code this
  // produced 604 chars against the 600 bound (see report for the
  // side-by-side run). It must never happen again, for any input.
  it("never lands a cut inside a surrogate pair, even one planted at the old cut boundary", () => {
    const plain = "A".repeat(5000);
    const shapeFor = (summary: string) => ({
      status: "ok",
      summary,
      turns: 3,
      wall_secs: 1,
      context: { peak_prompt_tokens: 21628, limit: 32768, pressure: 0.66 },
      truncations: 2,
      local_tokens: 500 + 20 + 8000 + 60 + 21628 + 100,
      transcript: "/t",
    });
    // Round 1's formula, reproduced only to find where it used to cut —
    // this is dead code as of this fix, kept solely to derive the rig.
    const fullLen = JSON.stringify(shapeFor(plain)).length;
    const marker = "...[truncated, see transcript]";
    const over = fullLen - 600 + 1;
    const cut = Math.min(plain.length, over + marker.length);
    const keepIndex = plain.length - cut;

    const emoji = "\u{1F600}"; // a surrogate pair: 2 UTF-16 code units, 1 code point
    const rigged = plain.slice(0, keepIndex - 1) + emoji + plain.slice(keepIndex + 1);
    expect(rigged.length).toBe(plain.length); // same length, pair now straddles the old boundary

    const e = buildEnvelope(
      { ...result, summary: rigged, detail: "" },
      { wallSecs: 1, transcript: "/t", contextLimit: 32768 },
    );
    expect(JSON.stringify(e).length).toBeLessThan(600);
  });

  // Fix round 2 addendum: a parity sweep showed the round-1 formula's
  // breach was not a rare coincidence — shifting the ascii prefix length by
  // a single character flipped BREACH/ok on every step, because whether a
  // cut landed mid-pair depended purely on parity, and the arithmetic had
  // no notion of pair boundaries at all (roughly half of adjacent lengths
  // breached). Sweep a window of adjacent offsets around the same derived
  // boundary and confirm none of them breach now — the fix must be
  // structural (true for every offset), not lucky (true for the one offset
  // already tested above).
  it("never breaches the bound at any offset near the old cut boundary, not just one", () => {
    const plain = "A".repeat(5000);
    const shapeFor = (summary: string) => ({
      status: "ok",
      summary,
      turns: 3,
      wall_secs: 1,
      context: { peak_prompt_tokens: 21628, limit: 32768, pressure: 0.66 },
      truncations: 2,
      local_tokens: 500 + 20 + 8000 + 60 + 21628 + 100,
      transcript: "/t",
    });
    const fullLen = JSON.stringify(shapeFor(plain)).length;
    const marker = "...[truncated, see transcript]";
    const over = fullLen - 600 + 1;
    const cut = Math.min(plain.length, over + marker.length);
    const keepIndex = plain.length - cut;

    const emoji = "\u{1F600}";
    for (let offset = -5; offset <= 5; offset++) {
      const idx = keepIndex + offset;
      const rigged = plain.slice(0, idx) + emoji + plain.slice(idx + 2);
      const e = buildEnvelope(
        { ...result, summary: rigged, detail: "" },
        { wallSecs: 1, transcript: "/t", contextLimit: 32768 },
      );
      expect(JSON.stringify(e).length).toBeLessThan(600);
    }
  });

  // Fix round 2, over-truncation: a closed-form cut assumed every removed
  // character costs 1 encoded byte, so it had to overshoot to be safe
  // against escaping — for text that's *mostly* escape-heavy (newlines,
  // tabs, quotes, backslashes are pervasive in error messages and model
  // output), that meant discarding far more than necessary. A multi-line
  // summary should keep close to the full budget, not surrender most of it.
  it("keeps close to the full budget for a multi-line summary instead of over-truncating", () => {
    const multiline = "line one\nline two\thas a tab\nline three has a \"quote\" and a \\backslash\\\n"
      .repeat(20);
    const e = buildEnvelope(
      { ...result, summary: multiline, detail: "" },
      { wallSecs: 1, transcript: "/t", contextLimit: 32768 },
    );
    expect(JSON.stringify(e).length).toBeLessThan(600);
    // The old formula's escape-heavy case kept only 271 bytes' worth out of
    // a 600 budget; retained text here should be substantially more (the
    // binary search converges on the true maximum fitting prefix, ~384
    // chars for this input).
    expect(e.summary.length).toBeGreaterThan(350);
  });

  // Fix round 2 addendum: the mixed-content case above still has plenty of
  // plain characters to fall back on. The worst case is a summary where
  // *every* character needs escaping — under round 1's formula that meant
  // `over` overshot text.length entirely and the `Math.min` clamp discarded
  // the whole field (the reviewer measured zero characters retained out of
  // 16,000). A gutted field silently reintroduces the empty-summary problem
  // this task's authorized addition exists to prevent, so this asserts more
  // than "under the bound" — it asserts real content survives.
  it("retains meaningful text even when every character needs JSON escaping", () => {
    const fullyEscaped = '"'.repeat(16000); // worst case: every character costs 2 encoded bytes
    const e = buildEnvelope(
      { ...result, summary: fullyEscaped, detail: "" },
      { wallSecs: 1, transcript: "/t", contextLimit: 32768 },
    );
    expect(JSON.stringify(e).length).toBeLessThan(600);
    expect(e.summary.length).toBeGreaterThan(100);
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
