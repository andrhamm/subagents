import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { glob, grep, listDir, MAX_MATCHES } from "../../src/tools/search";

let root: string;

// A line long enough to exceed grep's MAX_LINE (200) so its truncation
// indicator can be exercised: 50 + 10 + 210 = 270 chars, 70 over the cap.
const LONG_LINE = "x".repeat(50) + "LONGNEEDLE" + "y".repeat(210);

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "subagents-search-"));
  mkdirSync(join(root, "src"));
  mkdirSync(join(root, "node_modules"));
  mkdirSync(join(root, "restricted"));
  writeFileSync(join(root, "src", "a.ts"), "export const x = 1;\nconst y = validate(x);\n");
  writeFileSync(join(root, "src", "b.ts"), "const z = validate(2);\n");
  writeFileSync(join(root, "src", "notes.md"), "validate this prose\n");
  writeFileSync(join(root, "src", "long.ts"), `${LONG_LINE}\n`);
  writeFileSync(join(root, "node_modules", "junk.ts"), "validate(999);\n");
  writeFileSync(
    join(root, "src", "many.ts"),
    Array.from({ length: MAX_MATCHES + 40 }, () => "needle").join("\n") + "\n",
  );
  // Unreadable on purpose, to exercise the "files it could not read" marker.
  writeFileSync(join(root, "restricted", "secret.ts"), "validate(42);\n");
  chmodSync(join(root, "restricted", "secret.ts"), 0o000);
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

// chmod 000 does not block root from reading a file, so that test is skipped
// there rather than reporting a false failure.
const isRoot = typeof process.getuid === "function" && process.getuid() === 0;

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

  it("never surfaces match content from node_modules, and says so instead", async () => {
    const r = await grep.run({ pattern: "validate\\(", glob: "**/*.ts" }, { root });
    // No match line may originate from node_modules ...
    expect(r.content).not.toMatch(/node_modules\/[^:]+:\d+:/);
    // ... but the exclusion must be named, not silent.
    expect(r.content).toContain("EXCLUDED");
    expect(r.content).toContain("node_modules");
  });

  it("reports no matches plainly", async () => {
    // Scoped to src/** so this fixture's node_modules and restricted (an
    // unreadable file) never enter the scan — this test is about the plain
    // "no matches" case, not about omission reporting, which has its own tests.
    const r = await grep.run({ pattern: "zzzznope", glob: "src/**" }, { root });
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

  it("marks a match line cut at MAX_LINE with how much was withheld", async () => {
    const r = await grep.run({ pattern: "LONGNEEDLE", glob: "**/long.ts" }, { root });
    expect(r.content).toContain("LONGNEEDLE");
    expect(r.content).toContain("…[+70 chars]");
    expect(r.truncated).toBe(true);
  });

  it.skipIf(isRoot)("counts and reports files it could not read", async () => {
    const r = await grep.run({ pattern: "validate\\(", glob: "restricted/**" }, { root });
    expect(r.content).toContain("1 file unreadable, not searched");
    expect(r.truncated).toBe(true);
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

  it("reports how many paths were excluded and by which name", async () => {
    const r = await glob.run({ pattern: "**/*.ts" }, { root });
    expect(r.content).toContain("EXCLUDED");
    expect(r.content).toContain("1 path under node_modules");
    expect(r.truncated).toBe(true);
  });
});

describe("list_dir", () => {
  it("lists files under a directory, excluding node_modules content but naming it", async () => {
    const r = await listDir.run({ path: "." }, { root });
    expect(r.content).toContain("src/a.ts");
    expect(r.content).not.toContain("junk.ts");
    expect(r.content).toContain("EXCLUDED");
  });

  it("reports the exclusion when asked to list an excluded directory directly", async () => {
    // Same directory, reached directly this time instead of via traversal —
    // must give the same answer: excluded, not contents, not an empty list.
    const r = await listDir.run({ path: "node_modules" }, { root });
    expect(r.content).toContain("EXCLUDED");
    expect(r.content).toContain("node_modules");
    expect(r.content).not.toContain("junk.ts");
    expect(r.content).not.toBe("(no files)");
    expect(r.truncated).toBe(true);
  });
});
