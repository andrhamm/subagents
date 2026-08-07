import { describe, it, expect } from "bun:test";
import { parseConfig, resolveProfile, DEFAULTS } from "../src/config";

const YAML_OK = `
providers:
  local: { base_url: "http://127.0.0.1:1234/v1", kind: lmstudio }
  cloud: { base_url: "https://api.example.com/v1/" }
sampling:
  gemma-factual: { temperature: 0.3, top_p: 0.95, top_k: 64 }
tiers:
  cheap: { provider: local, model: "google/gemma-4-e2b", sampling: gemma-factual }
  strong: { provider: cloud, model: "big-model" }
profiles:
  digest: { tools: [read_file, glob, grep], tier: cheap }
defaults:
  max_turns: 12
`;

describe("parseConfig", () => {
  it("parses a valid config", () => {
    const cfg = parseConfig(YAML_OK);
    expect(Object.keys(cfg.providers)).toEqual(["local", "cloud"]);
  });

  it("rejects a config missing a required section", () => {
    expect(() => parseConfig("providers: {}\ntiers: {}\n")).toThrow(/profiles/);
  });

  it("rejects a non-mapping config", () => {
    expect(() => parseConfig("- a\n- b\n")).toThrow(/mapping/);
  });
});

describe("resolveProfile", () => {
  it("resolves provider, model and sampling from the tier", () => {
    const r = resolveProfile(parseConfig(YAML_OK), "digest");
    expect(r.baseUrl).toBe("http://127.0.0.1:1234/v1");
    expect(r.kind).toBe("lmstudio");
    expect(r.model).toBe("google/gemma-4-e2b");
    expect(r.sampling).toEqual({ temperature: 0.3, top_p: 0.95, top_k: 64 });
    expect(r.tools).toEqual(["read_file", "glob", "grep"]);
  });

  it("applies defaults and lets config override them", () => {
    const r = resolveProfile(parseConfig(YAML_OK), "digest");
    expect(r.maxTurns).toBe(12);
    expect(r.maxTokens).toBe(DEFAULTS.maxTokens);
  });

  it("strips trailing slashes from base_url", () => {
    const r = resolveProfile(parseConfig(YAML_OK), "digest", { tier: "strong" });
    expect(r.baseUrl).toBe("https://api.example.com/v1");
  });

  it("defaults provider kind to openai", () => {
    const r = resolveProfile(parseConfig(YAML_OK), "digest", { tier: "strong" });
    expect(r.kind).toBe("openai");
  });

  it("names the known profiles when one is unknown", () => {
    expect(() => resolveProfile(parseConfig(YAML_OK), "nope")).toThrow(/digest/);
  });

  it("rejects an unknown tier override", () => {
    expect(() => resolveProfile(parseConfig(YAML_OK), "digest", { tier: "ghost" }))
      .toThrow(/ghost/);
  });
});

const YAML_WRITES = `
providers:
  local: { base_url: "http://127.0.0.1:1234/v1" }
tiers:
  cheap: { provider: local, model: "m" }
profiles:
  digest:  { tools: [read_file, glob, grep], tier: cheap }
  fix:     { tools: [read_file, edit_file, write_file], tier: cheap, test_cmd: "bun test" }
  scratch: { tools: [read_file, write_file], tier: cheap, worktree: false }
  boxed:   { tools: [read_file], tier: cheap, worktree: true }
defaults:
  test_timeout_ms: 5000
`;

describe("write profiles", () => {
  it("defaults worktree off for a read-only profile", () => {
    const r = resolveProfile(parseConfig(YAML_WRITES), "digest");
    expect(r.worktree).toBe(false);
    expect(r.checks).toEqual([]);
  });

  it("defaults worktree on when the profile has a write tool", () => {
    const r = resolveProfile(parseConfig(YAML_WRITES), "fix");
    expect(r.worktree).toBe(true);
    expect(r.checks).toEqual([{ name: "tests", cmd: "bun test" }]);
  });

  it("rejects write tools with worktree explicitly off — in-place writes are not shipped", () => {
    expect(() => resolveProfile(parseConfig(YAML_WRITES), "scratch"))
      .toThrow(/worktree/);
  });

  it("allows an explicit worktree on a read-only profile", () => {
    expect(resolveProfile(parseConfig(YAML_WRITES), "boxed").worktree).toBe(true);
  });

  it("resolves test_timeout_ms from defaults, with a built-in fallback", () => {
    expect(resolveProfile(parseConfig(YAML_WRITES), "fix").testTimeoutMs).toBe(5000);
    expect(resolveProfile(parseConfig(YAML_OK), "digest").testTimeoutMs)
      .toBe(DEFAULTS.testTimeoutMs);
  });
});

describe("parseConfig section shapes", () => {
  // typeof [] === "object", so the original gate accepted `providers: []`
  // and failed later with a vaguer "unknown provider" — the ledger's oldest
  // open finding.
  it("rejects a required section that is an array rather than a mapping", () => {
    expect(() => parseConfig("providers: []\ntiers: {}\nprofiles: {}\n"))
      .toThrow(/invalid section 'providers'/);
  });
});

describe("provider concurrency", () => {
  it("resolves max_in_flight with a conservative default of 2", () => {
    const r = resolveProfile(parseConfig(YAML_OK), "digest");
    expect(r.maxInFlight).toBe(2);
    expect(r.provider).toBe("local");
  });

  it("honours a measured max_in_flight", () => {
    const yaml = YAML_OK.replace(
      'local: { base_url: "http://127.0.0.1:1234/v1", kind: lmstudio }',
      'local: { base_url: "http://127.0.0.1:1234/v1", kind: lmstudio, max_in_flight: 4 }',
    );
    expect(resolveProfile(parseConfig(yaml), "digest").maxInFlight).toBe(4);
  });

  it("rejects a non-positive or fractional max_in_flight", () => {
    const yaml = YAML_OK.replace(
      'local: { base_url: "http://127.0.0.1:1234/v1", kind: lmstudio }',
      'local: { base_url: "http://127.0.0.1:1234/v1", kind: lmstudio, max_in_flight: 0 }',
    );
    expect(() => resolveProfile(parseConfig(yaml), "digest")).toThrow(/max_in_flight/);
  });
});

const YAML_CHECKS = `
providers:
  local: { base_url: "http://127.0.0.1:1234/v1" }
tiers:
  cheap: { provider: local, model: "m" }
profiles:
  legacy:  { tools: [read_file, edit_file], tier: cheap, test_cmd: "bun test" }
  staged:
    tools: [read_file, edit_file, run_checks]
    tier: cheap
    checks:
      - { name: tests, cmd: "bun test" }
      - { name: style, cmd: "eslint src/" }
  both:    { tools: [read_file, edit_file], tier: cheap, test_cmd: "x", checks: [{ name: t, cmd: "y" }] }
  trigger: { tools: [read_file, run_checks], tier: cheap }
  nowt:    { tools: [read_file, run_checks], tier: cheap, checks: [{ name: t, cmd: "x" }] }
  dupes:
    tools: [read_file, edit_file]
    tier: cheap
    checks:
      - { name: tests, cmd: "a" }
      - { name: tests, cmd: "b" }
`;

describe("checks resolution", () => {
  it("desugars test_cmd into a single tests stage", () => {
    const r = resolveProfile(parseConfig(YAML_CHECKS), "legacy");
    expect(r.checks).toEqual([{ name: "tests", cmd: "bun test" }]);
  });

  it("resolves an ordered checks list as given", () => {
    const r = resolveProfile(parseConfig(YAML_CHECKS), "staged");
    expect(r.checks.map((c) => c.name)).toEqual(["tests", "style"]);
  });

  it("resolves an empty checks list for a profile with neither", () => {
    const r = resolveProfile(parseConfig(YAML_CHECKS.replace(/^  legacy.*$/m,
      '  legacy:  { tools: [read_file], tier: cheap }')), "legacy");
    expect(r.checks).toEqual([]);
  });

  it("rejects test_cmd and checks together — one spelling per profile", () => {
    expect(() => resolveProfile(parseConfig(YAML_CHECKS), "both"))
      .toThrow(/test_cmd.*checks|checks.*test_cmd/);
  });

  it("rejects run_checks in tools without any checks to run", () => {
    expect(() => resolveProfile(parseConfig(YAML_CHECKS), "trigger"))
      .toThrow(/run_checks.*no checks/);
  });

  it("rejects run_checks on a profile that runs without a worktree", () => {
    // Checks execute where the delegate edits. Without a worktree that
    // would be the caller's real tree — a caller-authored test command is
    // trusted to run, but only inside the disposable copy.
    expect(() => resolveProfile(parseConfig(YAML_CHECKS), "nowt"))
      .toThrow(/run_checks.*worktree/);
  });

  it("rejects duplicate stage names", () => {
    expect(() => resolveProfile(parseConfig(YAML_CHECKS), "dupes"))
      .toThrow(/duplicate check name 'tests'/);
  });

  it("rejects a stage missing name or cmd", () => {
    const bad = YAML_CHECKS.replace('{ name: tests, cmd: "bun test" }', '{ name: tests }');
    expect(() => resolveProfile(parseConfig(bad), "staged")).toThrow(/checks\[0\]/);
  });

  // sh -c "" exits 0 — an empty test_cmd would fabricate a green gate from a
  // command that ran nothing. Pre-branch, a falsy testCmd meant NO gate at
  // all; this spelling must fail loudly instead of reopening that hole.
  it("rejects an empty test_cmd, naming the profile", () => {
    const yaml = YAML_CHECKS.replace(
      'legacy:  { tools: [read_file, edit_file], tier: cheap, test_cmd: "bun test" }',
      'legacy:  { tools: [read_file, edit_file], tier: cheap, test_cmd: "" }');
    expect(() => resolveProfile(parseConfig(yaml), "legacy"))
      .toThrow(/profile 'legacy'.*test_cmd must not be empty/s);
  });

  it("rejects a whitespace-only test_cmd the same way", () => {
    const yaml = YAML_CHECKS.replace(
      'legacy:  { tools: [read_file, edit_file], tier: cheap, test_cmd: "bun test" }',
      'legacy:  { tools: [read_file, edit_file], tier: cheap, test_cmd: "   " }');
    expect(() => resolveProfile(parseConfig(yaml), "legacy"))
      .toThrow(/test_cmd must not be empty/);
  });
});
