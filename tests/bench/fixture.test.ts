import { describe, it, expect } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadFixture } from "../../src/bench/fixture";

function makeFixture(yaml: string, withFiles = true): string {
  const dir = mkdtempSync(join(tmpdir(), "subagents-fx-"));
  writeFileSync(join(dir, "fixture.yaml"), yaml);
  if (withFiles) {
    mkdirSync(join(dir, "files", "src"), { recursive: true });
    writeFileSync(join(dir, "files", "src", "a.ts"), "const a = 1;\n");
  }
  return dir;
}

const OK = `
task: "Count the things."
tools: [read_file, grep]
oracle:
  status: ok
  summary_must_match: ["\\\\b9\\\\b"]
  summary_must_not_match: ["\\\\b11\\\\b"]
`;

describe("loadFixture", () => {
  it("loads a valid read fixture", async () => {
    const dir = makeFixture(OK);
    try {
      const fx = await loadFixture(dir);
      expect(fx.task).toBe("Count the things.");
      expect(fx.tools).toEqual(["read_file", "grep"]);
      expect(fx.checks).toEqual([]);
      expect(fx.oracle.summary_must_match).toEqual(["\\b9\\b"]);
      expect(fx.name).toBe(dir.split("/").pop()!);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("loads checks and accepts run_checks in tools", async () => {
    const dir = makeFixture(`
task: "Fix it."
tools: [read_file, edit_file, run_checks]
checks:
  - { name: tests, cmd: "bun test" }
oracle: { checks_pass: true }
`);
    try {
      const fx = await loadFixture(dir);
      expect(fx.checks).toEqual([{ name: "tests", cmd: "bun test" }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects a missing task", async () => {
    const dir = makeFixture('tools: [read_file]\noracle: { status: ok }\n');
    try {
      await expect(loadFixture(dir)).rejects.toThrow(/task/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects an unknown tool, naming the knowns", async () => {
    const dir = makeFixture('task: t\ntools: [telepathy]\noracle: { status: ok }\n');
    try {
      await expect(loadFixture(dir)).rejects.toThrow(/telepathy.*read_file/s);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects an oracle regex that does not compile", async () => {
    const dir = makeFixture('task: t\ntools: [read_file]\noracle: { summary_must_match: ["([unclosed"] }\n');
    try {
      await expect(loadFixture(dir)).rejects.toThrow(/regex/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects a fixture without a files/ directory", async () => {
    const dir = makeFixture(OK, false);
    try {
      await expect(loadFixture(dir)).rejects.toThrow(/files\//);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("loads both committed fixtures", async () => {
    const routes = await loadFixture("bench/fixtures/routes-recall");
    expect(routes.oracle.summary_must_match!.length).toBeGreaterThanOrEqual(3);
    const greet = await loadFixture("bench/fixtures/greet-typo");
    expect(greet.oracle.checks_pass).toBe(true);
    expect(greet.oracle.files_changed).toEqual(["src/greet.ts"]);
  });
});
