import { existsSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { validateChecks, type CheckConfig } from "../config";
import { ALL_TOOLS } from "../tools/registry";
import { RUN_CHECKS_NAME } from "../tools/checks";

export interface FixtureOracle {
  /** Expected envelope status, e.g. "ok". Omit to accept any. */
  status?: string;
  /** Require the overall gate verdict. */
  checks_pass?: boolean;
  /** Exact expected files_changed, order-insensitive. */
  files_changed?: string[];
  /** Regex sources the summary must match — citations, required findings. */
  summary_must_match?: string[];
  /** Regex sources the summary must NOT match — fabrication traps. */
  summary_must_not_match?: string[];
}

export interface Fixture {
  name: string;
  /** Absolute fixture directory; files/ lives inside. */
  dir: string;
  task: string;
  tools: string[];
  checks: CheckConfig[];
  oracle: FixtureOracle;
}

function stringList(raw: unknown, where: string): string[] {
  if (!Array.isArray(raw) || raw.some((s) => typeof s !== "string")) {
    throw new Error(`${where} must be a list of strings`);
  }
  return raw as string[];
}

/** Load and validate one fixture directory. Every problem names the fixture. */
export async function loadFixture(dir: string): Promise<Fixture> {
  const abs = resolve(dir);
  const name = basename(abs);
  const where = `fixture '${name}'`;
  const yamlPath = join(abs, "fixture.yaml");
  if (!existsSync(yamlPath)) throw new Error(`${where}: no fixture.yaml in ${abs}`);
  const raw = Bun.YAML.parse(await Bun.file(yamlPath).text()) as Record<string, unknown> | null;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`${where}: fixture.yaml must be a mapping`);
  }

  if (typeof raw["task"] !== "string" || !raw["task"]) throw new Error(`${where}: missing 'task'`);
  const tools = stringList(raw["tools"], `${where}: tools`);
  const knowns = [...Object.keys(ALL_TOOLS), RUN_CHECKS_NAME];
  for (const t of tools) {
    if (!knowns.includes(t)) {
      throw new Error(`${where}: unknown tool '${t}'. available: ${knowns.join(", ")}`);
    }
  }
  const checks = raw["checks"] === undefined ? [] : validateChecks(raw["checks"], where);

  const rawOracle = raw["oracle"];
  if (rawOracle === null || typeof rawOracle !== "object" || Array.isArray(rawOracle)) {
    throw new Error(`${where}: missing 'oracle' mapping`);
  }
  const o = rawOracle as Record<string, unknown>;
  const oracle: FixtureOracle = {};
  if (o["status"] !== undefined) oracle.status = String(o["status"]);
  if (o["checks_pass"] !== undefined) oracle.checks_pass = o["checks_pass"] === true;
  if (o["files_changed"] !== undefined) {
    oracle.files_changed = stringList(o["files_changed"], `${where}: oracle.files_changed`);
  }
  for (const key of ["summary_must_match", "summary_must_not_match"] as const) {
    if (o[key] === undefined) continue;
    const sources = stringList(o[key], `${where}: oracle.${key}`);
    for (const src of sources) {
      try {
        new RegExp(src);
      } catch (e) {
        throw new Error(
          `${where}: oracle.${key} regex ${JSON.stringify(src)} does not compile: ` +
            `${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
    oracle[key] = sources;
  }

  const files = join(abs, "files");
  if (!existsSync(files) || !statSync(files).isDirectory()) {
    throw new Error(`${where}: missing files/ directory — the repo the delegate works in`);
  }

  return { name, dir: abs, task: raw["task"], tools, checks, oracle };
}
