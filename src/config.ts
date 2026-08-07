import type { SamplingParams } from "./types";
import { hasWriteTools } from "./tools/registry";

export interface ProviderConfig {
  base_url: string;
  kind?: "openai" | "lmstudio";
  /** Measured concurrency ceiling for this host. Default 2 — conservative. */
  max_in_flight?: number;
}
export interface TierConfig {
  provider: string;
  model: string;
  sampling?: string;
}

export interface CheckConfig {
  /** Short stage label; appears in the envelope's checks array. */
  name: string;
  /** Caller-authored shell command, run in the worktree. The model never writes this. */
  cmd: string;
}

/**
 * Validate a raw checks list from YAML. Shared by profile resolution and the
 * per-job override in batch — a bad stage must fail fast either way, naming
 * its position.
 */
export function validateChecks(raw: unknown, where: string): CheckConfig[] {
  if (!Array.isArray(raw)) throw new Error(`${where}: checks must be a list`);
  const seen = new Set<string>();
  return raw.map((c, i) => {
    if (c === null || typeof c !== "object" || Array.isArray(c)) {
      throw new Error(`${where}: checks[${i}] must be a mapping`);
    }
    const stage = c as Record<string, unknown>;
    if (typeof stage["name"] !== "string" || !stage["name"]) {
      throw new Error(`${where}: checks[${i}] missing 'name'`);
    }
    if (typeof stage["cmd"] !== "string" || !stage["cmd"]) {
      throw new Error(`${where}: checks[${i}] missing 'cmd'`);
    }
    if (seen.has(stage["name"])) {
      throw new Error(`${where}: duplicate check name '${stage["name"]}'`);
    }
    seen.add(stage["name"]);
    return { name: stage["name"], cmd: stage["cmd"] };
  });
}

/** test_cmd is sugar for a single tests stage; both spellings at once is ambiguous. */
export function desugarChecks(
  testCmd: string | undefined, checks: unknown, where: string,
): CheckConfig[] {
  if (testCmd !== undefined && checks !== undefined) {
    throw new Error(`${where}: give test_cmd or checks, not both`);
  }
  if (checks !== undefined) return validateChecks(checks, where);
  if (testCmd !== undefined) return [{ name: "tests", cmd: testCmd }];
  return [];
}

export interface ProfileConfig {
  tools: string[];
  tier: string;
  /** Run in a detached git worktree. Defaults to true iff the profile has a write tool. */
  worktree?: boolean;
  /** Command the harness runs after the delegate changed files. */
  test_cmd?: string;
  /** Ordered checks; replaces test_cmd alternative spelling. */
  checks?: CheckConfig[];
}
export interface Defaults {
  max_turns?: number;
  max_tokens?: number;
  timeout_ms?: number;
  test_timeout_ms?: number;
}
export interface Config {
  providers: Record<string, ProviderConfig>;
  sampling?: Record<string, SamplingParams>;
  tiers: Record<string, TierConfig>;
  profiles: Record<string, ProfileConfig>;
  defaults?: Defaults;
}

export interface ResolvedRun {
  baseUrl: string;
  kind: "openai" | "lmstudio";
  model: string;
  sampling: SamplingParams;
  tools: string[];
  maxTurns: number;
  maxTokens: number;
  timeoutMs: number;
  worktree: boolean;
  checks: CheckConfig[];
  testTimeoutMs: number;
  /** The tier's provider name — batch groups jobs by (provider, model). */
  provider: string;
  maxInFlight: number;
}

export const DEFAULTS = {
  maxTurns: 20,
  maxTokens: 8000,
  timeoutMs: 300_000,
  testTimeoutMs: 120_000,
} as const;

const REQUIRED_SECTIONS = ["providers", "tiers", "profiles"] as const;

export function parseConfig(text: string): Config {
  const raw = Bun.YAML.parse(text) as unknown;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("config: top level must be a mapping");
  }
  const cfg = raw as Config;
  for (const section of REQUIRED_SECTIONS) {
    const value = cfg[section] as unknown;
    if (
      value === undefined || value === null ||
      typeof value !== "object" || Array.isArray(value)
    ) {
      throw new Error(`config: missing or invalid section '${section}' (must be a mapping)`);
    }
  }
  return cfg;
}

function known(record: Record<string, unknown>): string {
  const keys = Object.keys(record);
  return keys.length ? keys.join(", ") : "(none defined)";
}

export function resolveProfile(
  cfg: Config,
  profileName: string,
  overrides: { tier?: string } = {},
): ResolvedRun {
  const profile = cfg.profiles[profileName];
  if (!profile) {
    throw new Error(
      `unknown profile '${profileName}'. known profiles: ${known(cfg.profiles)}`,
    );
  }
  const tierName = overrides.tier ?? profile.tier;
  const tier = cfg.tiers[tierName];
  if (!tier) {
    throw new Error(`unknown tier '${tierName}'. known tiers: ${known(cfg.tiers)}`);
  }
  const provider = cfg.providers[tier.provider];
  if (!provider) {
    throw new Error(
      `unknown provider '${tier.provider}'. known providers: ${known(cfg.providers)}`,
    );
  }

  const maxInFlight = provider.max_in_flight ?? 2;
  if (!Number.isInteger(maxInFlight) || maxInFlight <= 0) {
    throw new Error(
      `provider '${tier.provider}': max_in_flight must be a positive integer, ` +
        `got ${JSON.stringify(provider.max_in_flight)}`,
    );
  }

  let sampling: SamplingParams = {};
  if (tier.sampling !== undefined) {
    const preset = cfg.sampling?.[tier.sampling];
    if (!preset) {
      throw new Error(
        `unknown sampling preset '${tier.sampling}'. known presets: ` +
          `${known(cfg.sampling ?? {})}`,
      );
    }
    sampling = preset;
  }

  const d = cfg.defaults ?? {};
  const writes = hasWriteTools(profile.tools);
  const worktree = profile.worktree ?? writes;
  if (writes && !worktree) {
    throw new Error(
      `profile '${profileName}' has write tools but 'worktree: false' — in-place ` +
        "writes are not supported; drop the override or the write tools",
    );
  }

  const resolvedChecks = desugarChecks(
    profile.test_cmd, profile.checks, `profile '${profileName}'`);
  if (profile.tools.includes("run_checks") && resolvedChecks.length === 0) {
    throw new Error(
      `profile '${profileName}' lists run_checks but has no checks to run — ` +
        "add test_cmd or a checks list",
    );
  }
  if (profile.tools.includes("run_checks") && !worktree) {
    throw new Error(
      `profile '${profileName}' lists run_checks but runs without a worktree — ` +
        "checks execute where the delegate works; add a write tool or 'worktree: true'",
    );
  }

  return {
    baseUrl: provider.base_url.replace(/\/+$/, ""),
    kind: provider.kind ?? "openai",
    model: tier.model,
    sampling,
    tools: profile.tools,
    maxTurns: d.max_turns ?? DEFAULTS.maxTurns,
    maxTokens: d.max_tokens ?? DEFAULTS.maxTokens,
    timeoutMs: d.timeout_ms ?? DEFAULTS.timeoutMs,
    worktree,
    checks: resolvedChecks,
    testTimeoutMs: d.test_timeout_ms ?? DEFAULTS.testTimeoutMs,
    provider: tier.provider,
    maxInFlight,
  };
}
