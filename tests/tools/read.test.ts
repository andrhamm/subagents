import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { safePath } from "../../src/tools/paths";
import { readFile } from "../../src/tools/read";

// safePath realpaths its root, and on macOS mkdtemp gives /var/... while
// realpath gives /private/var/... — compare against the resolved form.
let root: string;
let realRoot: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "subagents-read-"));
  realRoot = realpathSync(root);
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "small.ts"), "alpha\nbravo\ncharlie\n");
  writeFileSync(
    join(root, "src", "big.ts"),
    Array.from({ length: 500 }, (_, i) => `line ${i + 1}`).join("\n") + "\n",
  );
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("safePath", () => {
  it("resolves a path inside the root", () => {
    expect(safePath(root, "src/small.ts")).toBe(join(realRoot, "src/small.ts"));
  });

  it("rejects a path escaping the root", () => {
    expect(() => safePath(root, "../../etc/passwd")).toThrow(/escapes root/);
  });

  it("rejects an absolute path outside the root", () => {
    expect(() => safePath(root, "/etc/passwd")).toThrow(/escapes root/);
  });
});

describe("read_file", () => {
  it("numbers every line, tab-separated, starting at 1", async () => {
    const r = await readFile.run({ path: "src/small.ts" }, { root });
    expect(r.content.split("\n")).toEqual([
      "     1\talpha",
      "     2\tbravo",
      "     3\tcharlie",
    ]);
    expect(r.truncated).toBe(false);
  });

  it("does not invent a trailing blank line", async () => {
    const r = await readFile.run({ path: "src/small.ts" }, { root });
    expect(r.content.endsWith("charlie")).toBe(true);
  });

  it("pages with offset and reports absolute line numbers", async () => {
    const r = await readFile.run({ path: "src/big.ts", offset: 200, limit: 2 }, { root });
    expect(r.content).toContain("   200\tline 200");
    expect(r.content).toContain("   201\tline 201");
    expect(r.content).not.toContain("line 199");
  });

  it("marks truncation explicitly with the withheld count and next offset", async () => {
    const r = await readFile.run({ path: "src/big.ts", limit: 190 }, { root });
    expect(r.truncated).toBe(true);
    expect(r.content).toContain("TRUNCATED");
    expect(r.content).toContain("lines 1-190 of 500");
    expect(r.content).toContain("310 not shown");
    expect(r.content).toContain("offset=191");
  });

  it("does not mark truncation when the whole file fits", async () => {
    const r = await readFile.run({ path: "src/big.ts", limit: 500 }, { root });
    expect(r.truncated).toBe(false);
    expect(r.content).not.toContain("TRUNCATED");
  });

  it("reports reaching end of file when paging past the start", async () => {
    const r = await readFile.run({ path: "src/big.ts", offset: 499 }, { root });
    expect(r.truncated).toBe(false);
    expect(r.content).toContain("end of file at line 500");
  });

  it("advertises offset and limit in its schema", () => {
    const props = readFile.schema.function.parameters.properties;
    expect(Object.keys(props).sort()).toEqual(["limit", "offset", "path"]);
    expect(readFile.schema.function.description).toContain("TRUNCATED");
  });
});
