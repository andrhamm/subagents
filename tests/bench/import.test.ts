import { describe, it, expect, afterEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importTrack } from "../../src/bench/import-exercism";
import { loadFixture } from "../../src/bench/fixture";

function fakeTrack(): string {
  const dir = mkdtempSync(join(tmpdir(), "subagents-track-"));
  // A solvable exercise: exemplar passes its test.
  const good = join(dir, "exercises", "practice", "two-fer");
  mkdirSync(join(good, ".meta"), { recursive: true });
  writeFileSync(join(good, "two-fer.ts"),
    "export function twoFer(name?: string): string {\n  throw new Error('implement');\n}\n");
  writeFileSync(join(good, "two-fer.test.ts"), `
import { describe, it, expect } from "bun:test";
import { twoFer } from "./two-fer";
describe("twoFer", () => {
  it("defaults to you", () => expect(twoFer()).toBe("One for you, one for me."));
  it("names names", () => expect(twoFer("Alice")).toBe("One for Alice, one for me."));
});
`);
  writeFileSync(join(good, ".meta", "exemplar.ts"),
    'export function twoFer(name = "you"): string {\n  return `One for ${name}, one for me.`;\n}\n');
  writeFileSync(join(good, ".meta", "config.json"), JSON.stringify({
    files: { solution: ["two-fer.ts"], test: ["two-fer.test.ts"], exemplar: [".meta/exemplar.ts"] },
  }));
  writeFileSync(join(good, "README.md"), "# Two Fer\nReturn 'One for X, one for me.'\n");

  // A broken exercise: exemplar does NOT pass (wrong expected string).
  const bad = join(dir, "exercises", "practice", "broken-ex");
  mkdirSync(join(bad, ".meta"), { recursive: true });
  writeFileSync(join(bad, "broken-ex.ts"), "export const x = () => 0;\n");
  writeFileSync(join(bad, "broken-ex.test.ts"), `
import { it, expect } from "bun:test";
import { x } from "./broken-ex";
it("wants 1", () => expect(x()).toBe(1));
`);
  writeFileSync(join(bad, ".meta", "exemplar.ts"), "export const x = () => 0;\n");
  writeFileSync(join(bad, ".meta", "config.json"), JSON.stringify({
    files: { solution: ["broken-ex.ts"], test: ["broken-ex.test.ts"], exemplar: [".meta/exemplar.ts"] },
  }));
  writeFileSync(join(bad, "README.md"), "# Broken\n");

  // A mangled exercise: .meta/config.json is invalid JSON.
  const mangled = join(dir, "exercises", "practice", "mangled-ex");
  mkdirSync(join(mangled, ".meta"), { recursive: true });
  writeFileSync(join(mangled, "mangled-ex.ts"), "export const y = () => 1;\n");
  writeFileSync(join(mangled, "mangled-ex.test.ts"), `
import { it, expect } from "bun:test";
import { y } from "./mangled-ex";
it("works", () => expect(y()).toBe(1));
`);
  writeFileSync(join(mangled, ".meta", "exemplar.ts"), "export const y = () => 1;\n");
  writeFileSync(join(mangled, ".meta", "config.json"), "{not json");
  writeFileSync(join(mangled, "README.md"), "# Mangled\n");

  // No README exercise: valid meta + passing exemplar, but no README.md.
  const noreadme = join(dir, "exercises", "practice", "no-readme-ex");
  mkdirSync(join(noreadme, ".meta"), { recursive: true });
  writeFileSync(join(noreadme, "no-readme-ex.ts"), "export const z = () => 2;\n");
  writeFileSync(join(noreadme, "no-readme-ex.test.ts"), `
import { it, expect } from "bun:test";
import { z } from "./no-readme-ex";
it("works", () => expect(z()).toBe(2));
`);
  writeFileSync(join(noreadme, ".meta", "exemplar.ts"), "export const z = () => 2;\n");
  writeFileSync(join(noreadme, ".meta", "config.json"), JSON.stringify({
    files: { solution: ["no-readme-ex.ts"], test: ["no-readme-ex.test.ts"], exemplar: [".meta/exemplar.ts"] },
  }));

  return dir;
}

const cleanups: string[] = [];
afterEach(() => { for (const d of cleanups.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe("importTrack", () => {
  it("imports the solvable exercise as a loadable fixture and skips the broken ones, with reasons", async () => {
    const track = fakeTrack();
    const dest = mkdtempSync(join(tmpdir(), "subagents-imp-"));
    cleanups.push(track, dest);

    const r = await importTrack(track, dest);
    expect(r.imported).toEqual(["two-fer"]);
    expect(r.skipped).toHaveLength(3);
    const skippedSlugs = r.skipped.map((s) => s.slug).sort();
    expect(skippedSlugs).toEqual(["broken-ex", "mangled-ex", "no-readme-ex"]);

    // Verify specific skip reasons.
    const bySlug = Object.fromEntries(r.skipped.map((s) => [s.slug, s.reason]));
    expect(bySlug["broken-ex"]).toMatch(/exemplar.*fail/i);
    expect(bySlug["mangled-ex"]).toMatch(/unexpected error/i);
    expect(bySlug["no-readme-ex"]).toBe("no README.md");

    // Verify the solvable one still imported and is loadable.
    const fx = await loadFixture(join(dest, "two-fer"));
    expect(fx.task).toContain("README");
    expect(fx.tools).toContain("edit_file");
    expect(fx.tools).toContain("run_checks");
    expect(fx.checks).toEqual([{ name: "tests", cmd: "bun test" }]);
    expect(fx.oracle.checks_pass).toBe(true);
    // The fixture ships the STUB, not the exemplar — the task is unsolved.
    const stub = await Bun.file(join(dest, "two-fer", "files", "two-fer.ts")).text();
    expect(stub).toContain("implement");
    // No .meta leakage: the exemplar must not ride along as a crib.
    expect(existsSync(join(dest, "two-fer", "files", ".meta"))).toBe(false);
  });

  it("honors a slug filter", async () => {
    const track = fakeTrack();
    const dest = mkdtempSync(join(tmpdir(), "subagents-imp-"));
    cleanups.push(track, dest);
    const r = await importTrack(track, dest, { slugs: ["broken-ex"] });
    expect(r.imported).toEqual([]);
    expect(r.skipped).toHaveLength(1);
  });
});
