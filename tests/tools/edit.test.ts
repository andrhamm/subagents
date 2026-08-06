import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newSession, type RunSession } from "../../src/tools/types";
import { readFile } from "../../src/tools/read";
import { editFile } from "../../src/tools/edit";

let root: string;
let session: RunSession;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "subagents-edit-"));
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "a.ts"), "const a = 1;\nconst b = 2;\nconst c = 3;\n");
  writeFileSync(join(root, "src", "dup.ts"), "x();\nx();\nx();\n");
  session = newSession();
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

/** Populate the session the way a real run does — through read_file itself,
 * so this suite locks the two tools to the same path-key format. */
async function read(path: string): Promise<void> {
  await readFile.run({ path }, { root, session });
}

describe("edit_file", () => {
  it("replaces a unique match and shows a numbered snippet of the result", async () => {
    await read("src/a.ts");
    const r = await editFile.run(
      { path: "src/a.ts", old_string: "const b = 2;", new_string: "const b = 20;" },
      { root, session },
    );
    expect(r.truncated).toBe(false);
    expect(r.content).toContain("Edited src/a.ts (1 replacement)");
    expect(r.content).toContain("2\tconst b = 20;");
    expect(await Bun.file(join(root, "src", "a.ts")).text())
      .toBe("const a = 1;\nconst b = 20;\nconst c = 3;\n");
  });

  it("refuses to edit a file not read this session, and says what to do", async () => {
    await expect(
      editFile.run(
        { path: "src/a.ts", old_string: "const a = 1;", new_string: "const a = 9;" },
        { root, session },
      ),
    ).rejects.toThrow(/read_file it first/);
  });

  it("refuses an identical old_string and new_string", async () => {
    await read("src/a.ts");
    await expect(
      editFile.run(
        { path: "src/a.ts", old_string: "const a = 1;", new_string: "const a = 1;" },
        { root, session },
      ),
    ).rejects.toThrow(/identical/);
  });

  it("refuses an empty old_string", async () => {
    await read("src/a.ts");
    await expect(
      editFile.run({ path: "src/a.ts", old_string: "", new_string: "x" }, { root, session }),
    ).rejects.toThrow(/empty/);
  });

  it("reports a missing match and tells the model to re-read", async () => {
    await read("src/a.ts");
    await expect(
      editFile.run(
        { path: "src/a.ts", old_string: "const z = 9;", new_string: "y" },
        { root, session },
      ),
    ).rejects.toThrow(/not found.*re-read/is);
  });

  it("names the occurrence count when the match is ambiguous", async () => {
    await read("src/dup.ts");
    await expect(
      editFile.run({ path: "src/dup.ts", old_string: "x();", new_string: "y();" }, { root, session }),
    ).rejects.toThrow(/matches 3 times/);
  });

  it("replace_all replaces every occurrence and reports the count", async () => {
    await read("src/dup.ts");
    const r = await editFile.run(
      { path: "src/dup.ts", old_string: "x();", new_string: "y();", replace_all: true },
      { root, session },
    );
    expect(r.content).toContain("Edited src/dup.ts (3 replacements)");
    expect(await Bun.file(join(root, "src", "dup.ts")).text()).toBe("y();\ny();\ny();\n");
  });

  it("reports a nonexistent file as such, not as unread", async () => {
    await expect(
      editFile.run({ path: "src/ghost.ts", old_string: "a", new_string: "b" }, { root, session }),
    ).rejects.toThrow(/file not found/);
  });

  it("rejects a path escaping the root", async () => {
    await expect(
      editFile.run({ path: "../evil.ts", old_string: "a", new_string: "b" }, { root, session }),
    ).rejects.toThrow(/escapes root/);
  });

  it("advertises its parameters and the read-first rule in its schema", () => {
    const props = editFile.schema.function.parameters.properties;
    expect(Object.keys(props).sort()).toEqual(["new_string", "old_string", "path", "replace_all"]);
    expect(editFile.schema.function.description).toContain("read_file");
  });
});
