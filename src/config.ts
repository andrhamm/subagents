import type { SamplingParams } from "./types";

export interface ProviderConfig {
  base_url: string;
  kind?: "openai" | "lmstudio";
}
export interface TierConfig {
  provider: string;
  model: string;
  sampling?: string;
}
export interface ProfileConfig {
  tools: string[];
  tier: string;
}
export interface Defaults {
  max_turns?: number;
  max_tokens?: number;
  timeout_ms?: number;
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
}

export const DEFAULTS = {
  maxTurns: 20,
  maxTokens: 8000,
  timeoutMs: 300_000,
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
    if (value === undefined || value === null || typeof value !== "object") {
      throw new Error(`config: missing required section '${section}'`);
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
  return {
    baseUrl: provider.base_url.replace(/\/+$/, ""),
    kind: provider.kind ?? "openai",
    model: tier.model,
    sampling,
    tools: profile.tools,
    maxTurns: d.max_turns ?? DEFAULTS.maxTurns,
    maxTokens: d.max_tokens ?? DEFAULTS.maxTokens,
    timeoutMs: d.timeout_ms ?? DEFAULTS.timeoutMs,
  };
}
