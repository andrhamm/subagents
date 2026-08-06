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
    expect(r.testCmd).toBeUndefined();
  });

  it("defaults worktree on when the profile has a write tool", () => {
    const r = resolveProfile(parseConfig(YAML_WRITES), "fix");
    expect(r.worktree).toBe(true);
    expect(r.testCmd).toBe("bun test");
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
