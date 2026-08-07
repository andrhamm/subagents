import { describe, it, expect } from "bun:test";
import { markIfCut, markIfCutTail } from "../src/text";

describe("markIfCutTail", () => {
  it("returns short text untouched", () => {
    expect(markIfCutTail("all of it", 100)).toBe("all of it");
  });

  it("keeps the tail and marks the front cut — failures print at the end", () => {
    const text = "HEAD-NOISE ".repeat(50) + "FAIL: expected 2, got 3";
    const cut = markIfCutTail(text, 60);
    expect(cut).toContain("FAIL: expected 2, got 3");
    expect(cut).not.toContain("HEAD-NOISE HEAD-NOISE HEAD-NOISE HEAD-NOISE");
    expect(cut).toMatch(/^\[\d+ chars cut from the front\]…/);
  });

  it("counts the cut honestly", () => {
    const text = "a".repeat(100) + "tail";
    const cut = markIfCutTail(text, 20);
    const counted = Number(cut.match(/^\[(\d+) chars cut/)![1]);
    expect(counted).toBe(text.length - 20);
  });
});

describe("markIfCut", () => {
  it("still keeps the head for diagnostics", () => {
    expect(markIfCut("abcdef", 3)).toBe("abc…");
  });
});
