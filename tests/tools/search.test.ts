import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { glob, grep, listDir, MAX_MATCHES } from "../../src/tools/search";

let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "subagents-search-"));
  mkdirSync(join(root, "src"));
  mkdirSync(join(root, "node_modules"));
  writeFileSync(join(root, "src", "a.ts"), "export const x = 1;\nconst y = validate(x);\n");
  writeFileSync(join(root, "src", "b.ts"), "const z = validate(2);\n");
  writeFileSync(join(root, "src", "notes.md"), "validate this prose\n");
  writeFileSync(join(root, "node_modules", "junk.ts"), "validate(999);\n");
  writeFileSync(
    join(root, "src", "many.ts"),
    Array.from({ length: MAX_MATCHES + 40 }, () => "needle").join("\n") + "\n",
  );
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("grep", () => {
  it("returns path:line:text for matches", async () => {
    const r = await grep.run({ pattern: "validate\\(", glob: "**/*.ts" }, { root });
    expect(r.content).toContain("src/a.ts:2:const y = validate(x);");
    expect(r.content).toContain("src/b.ts:1:const z = validate(2);");
  });

  it("honours the glob filter", async () => {
    const r = await grep.run({ pattern: "validate", glob: "**/*.md" }, { root });
    expect(r.content).toContain("notes.md");
    expect(r.content).not.toContain("a.ts");
  });

  it("skips node_modules", async () => {
    const r = await grep.run({ pattern: "validate\\(", glob: "**/*.ts" }, { root });
    expect(r.content).not.toContain("node_modules");
  });

  it("reports no matches plainly", async () => {
    const r = await grep.run({ pattern: "zzzznope" }, { root });
    expect(r.content).toBe("(no matches)");
    expect(r.truncated).toBe(false);
  });

  it("caps matches and says how many were withheld", async () => {
    const r = await grep.run({ pattern: "needle", glob: "**/many.ts" }, { root });
    expect(r.truncated).toBe(true);
    expect(r.content).toContain("TRUNCATED");
    expect(r.content).toContain(`showing ${MAX_MATCHES} of ${MAX_MATCHES + 40}`);
  });

  it("reports an invalid regex as a tool error, not a crash", async () => {
    await expect(grep.run({ pattern: "([unclosed" }, { root })).rejects.toThrow(/regex/i);
  });
});

describe("glob", () => {
  it("lists matching files relative to root", async () => {
    const r = await glob.run({ pattern: "src/*.ts" }, { root });
    const lines = r.content.split("\n").sort();
    expect(lines).toContain("src/a.ts");
    expect(lines).toContain("src/b.ts");
    expect(r.content).not.toContain("notes.md");
  });

  it("reports no matches plainly", async () => {
    const r = await glob.run({ pattern: "*.rs" }, { root });
    expect(r.content).toBe("(no matches)");
  });
});

describe("list_dir", () => {
  it("lists files under a directory and skips node_modules", async () => {
    const r = await listDir.run({ path: "." }, { root });
    expect(r.content).toContain("src/a.ts");
    expect(r.content).not.toContain("node_modules");
  });
});
