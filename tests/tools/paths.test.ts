import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { safeWritePath } from "../../src/tools/paths";

let root: string;
let realRoot: string;
let outside: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "subagents-paths-"));
  realRoot = realpathSync(root);
  outside = mkdtempSync(join(tmpdir(), "subagents-outside-"));
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "a.ts"), "x\n");
  // A directory that *looks* inside the root but is really a symlink out of
  // it. safePath catches this for existing targets (it realpaths them), but
  // returns a not-yet-existing target unresolved — which is exactly the
  // shape write_file creates. safeWritePath must catch it.
  symlinkSync(outside, join(root, "vendor"));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

describe("safeWritePath", () => {
  it("resolves an existing file inside the root", () => {
    expect(safeWritePath(root, "src/a.ts")).toBe(join(realRoot, "src", "a.ts"));
  });

  it("allows a new file in an existing directory", () => {
    expect(safeWritePath(root, "src/new.ts")).toBe(join(realRoot, "src", "new.ts"));
  });

  it("allows a new file under directories that do not exist yet", () => {
    expect(safeWritePath(root, "src/deep/nested/new.ts"))
      .toBe(join(realRoot, "src", "deep", "nested", "new.ts"));
  });

  it("rejects a new file under a symlinked directory pointing outside the root", () => {
    expect(() => safeWritePath(root, "vendor/evil.ts")).toThrow(/escapes root/);
  });

  it("rejects a relative escape", () => {
    expect(() => safeWritePath(root, "../evil.ts")).toThrow(/escapes root/);
  });

  it("rejects an absolute path outside the root", () => {
    expect(() => safeWritePath(root, "/etc/evil")).toThrow(/escapes root/);
  });
});
