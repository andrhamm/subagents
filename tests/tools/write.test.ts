import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newSession, type RunSession } from "../../src/tools/types";
import { readFile } from "../../src/tools/read";
import { editFile } from "../../src/tools/edit";
import { writeFile } from "../../src/tools/write";

let root: string;
let outside: string;
let session: RunSession;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "subagents-write-"));
  outside = mkdtempSync(join(tmpdir(), "subagents-write-out-"));
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "a.ts"), "old content\n");
  symlinkSync(outside, join(root, "vendor"));
  session = newSession();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

describe("write_file", () => {
  it("creates a new file and reports its line count", async () => {
    const r = await writeFile.run(
      { path: "src/new.ts", content: "const x = 1;\nconst y = 2;\n" },
      { root, session },
    );
    expect(r.truncated).toBe(false);
    expect(r.content).toBe("Wrote src/new.ts (2 lines).");
    expect(await Bun.file(join(root, "src", "new.ts")).text()).toBe("const x = 1;\nconst y = 2;\n");
  });

  it("creates parent directories for a nested new path", async () => {
    await writeFile.run(
      { path: "src/deep/nested/new.ts", content: "x\n" },
      { root, session },
    );
    expect(existsSync(join(root, "src", "deep", "nested", "new.ts"))).toBe(true);
  });

  it("refuses to overwrite a file not read this session", async () => {
    await expect(
      writeFile.run({ path: "src/a.ts", content: "clobbered\n" }, { root, session }),
    ).rejects.toThrow(/read_file it first/);
    expect(await Bun.file(join(root, "src", "a.ts")).text()).toBe("old content\n");
  });

  it("overwrites after a read", async () => {
    await readFile.run({ path: "src/a.ts" }, { root, session });
    const r = await writeFile.run(
      { path: "src/a.ts", content: "new content\n" },
      { root, session },
    );
    expect(r.content).toBe("Wrote src/a.ts (1 line).");
    expect(await Bun.file(join(root, "src", "a.ts")).text()).toBe("new content\n");
  });

  it("marks the written file readable-for-edit — no fresh read needed", async () => {
    await writeFile.run({ path: "src/gen.ts", content: "const g = 1;\n" }, { root, session });
    const r = await editFile.run(
      { path: "src/gen.ts", old_string: "const g = 1;", new_string: "const g = 2;" },
      { root, session },
    );
    expect(r.content).toContain("Edited src/gen.ts");
  });

  it("writes an empty file and says 0 lines", async () => {
    const r = await writeFile.run({ path: "src/empty.ts", content: "" }, { root, session });
    expect(r.content).toBe("Wrote src/empty.ts (0 lines).");
  });

  it("rejects a new file under a symlinked directory pointing outside the root", async () => {
    await expect(
      writeFile.run({ path: "vendor/evil.ts", content: "x" }, { root, session }),
    ).rejects.toThrow(/escapes root/);
    expect(existsSync(join(outside, "evil.ts"))).toBe(false);
  });

  it("rejects a relative escape", async () => {
    await expect(
      writeFile.run({ path: "../evil.ts", content: "x" }, { root, session }),
    ).rejects.toThrow(/escapes root/);
  });

  it("advertises overwrite-requires-read in its schema", () => {
    const props = writeFile.schema.function.parameters.properties;
    expect(Object.keys(props).sort()).toEqual(["content", "path"]);
    expect(writeFile.schema.function.description).toContain("read");
  });

  it("appends a syntax note when written TS does not parse", async () => {
    const r = await writeFile.run(
      { path: "src/broken.ts", content: "export const x: number = ;\n" },
      { root, session },
    );
    expect(r.content).toContain("[SYNTAX:");
  });

  it("skips syntax checking for non-JS/TS files", async () => {
    const r = await writeFile.run(
      { path: "notes.md", content: "not : valid ( ts — and that is fine\n" },
      { root, session },
    );
    expect(r.content).not.toContain("[SYNTAX:");
  });
});
