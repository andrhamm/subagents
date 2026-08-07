import { describe, it, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeProgress } from "../../src/batch/progress";

describe("writeProgress", () => {
  it("writes the state as one parseable JSON line", async () => {
    const dir = mkdtempSync(join(tmpdir(), "subagents-prog-"));
    const path = join(dir, "progress.json");
    try {
      await writeProgress(path, {
        total: 3, done: ["a"], running: ["b"], pending: ["c"], not_run: [],
      });
      const text = await Bun.file(path).text();
      expect(text.endsWith("\n")).toBe(true);
      const back = JSON.parse(text);
      expect(back).toEqual({
        total: 3, done: ["a"], running: ["b"], pending: ["c"], not_run: [],
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
