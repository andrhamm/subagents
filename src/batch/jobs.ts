import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { CheckConfig, Config, ResolvedRun } from "../config";
import { assertRunChecksUsable, desugarChecks, resolveProfile, validateChecks } from "../config";

export interface JobSpec {
  id: string;
  profile: string;
  task: string;
  root?: string;
  tier?: string;
  test_cmd?: string;
  checks?: CheckConfig[];
}

export interface ResolvedJob {
  id: string;
  spec: JobSpec;
  run: ResolvedRun;
  /** Absolute, existence-checked. */
  root: string;
}

/**
 * Job ids flow unescaped into `join(transcriptDir, \`${id}.json\`)` — a
 * permissive id (a path separator, ".." ) would let a job write its
 * transcript outside transcriptDir. Restricting to this set closes that off
 * at parse time, before any job runs.
 */
const VALID_ID = /^[A-Za-z0-9._-]+$/;

export function parseJobs(text: string): JobSpec[] {
  const raw = Bun.YAML.parse(text) as unknown;
  const jobs = raw !== null && typeof raw === "object" && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)["jobs"]
    : undefined;
  if (!Array.isArray(jobs) || jobs.length === 0) {
    throw new Error("jobs file: top level must be a mapping with a non-empty 'jobs' list");
  }
  const seen = new Set<string>();
  return jobs.map((j, i) => {
    if (j === null || typeof j !== "object" || Array.isArray(j)) {
      throw new Error(`jobs[${i}]: must be a mapping`);
    }
    const job = j as Record<string, unknown>;
    if (typeof job["profile"] !== "string" || !job["profile"]) {
      throw new Error(`jobs[${i}]: missing 'profile'`);
    }
    if (typeof job["task"] !== "string" || !job["task"]) {
      throw new Error(`jobs[${i}]: missing 'task'`);
    }
    const id = job["id"] === undefined ? `j${i + 1}` : String(job["id"]);
    if (!VALID_ID.test(id)) {
      throw new Error(`jobs[${i}]: id must match ${VALID_ID} — got '${id}'`);
    }
    if (seen.has(id)) throw new Error(`jobs: duplicate id '${id}'`);
    seen.add(id);
    return {
      id,
      profile: job["profile"],
      task: job["task"],
      ...(typeof job["root"] === "string" ? { root: job["root"] } : {}),
      ...(typeof job["tier"] === "string" ? { tier: job["tier"] } : {}),
      ...(typeof job["test_cmd"] === "string" ? { test_cmd: job["test_cmd"] } : {}),
      ...(job["checks"] !== undefined ? { checks: validateChecks(job["checks"], `jobs[${i}]`) } : {}),
    };
  });
}

/**
 * Resolve every job before any runs. One bad job fails the whole batch up
 * front — a typo'd profile discovered at job 29 of 30 wastes the 28 before it.
 */
export function resolveJobs(cfg: Config, specs: JobSpec[], defaultRoot: string): ResolvedJob[] {
  return specs.map((spec) => {
    let run: ResolvedRun;
    try {
      run = resolveProfile(cfg, spec.profile, spec.tier !== undefined ? { tier: spec.tier } : {});
    } catch (e) {
      throw new Error(`job '${spec.id}': ${e instanceof Error ? e.message : String(e)}`);
    }
    if (spec.test_cmd !== undefined || spec.checks !== undefined) {
      // `where` already carries the job's identity, so desugarChecks's own
      // message needs no outer wrap — wrapping it a second time doubled
      // "job" in the error text ("job 'x': job: ...").
      const where = `job '${spec.id}'`;
      const checks = desugarChecks(spec.test_cmd, spec.checks, where);
      // A job's checks:[] override replaces what resolveProfile validated —
      // it must clear the same run_checks bar the profile did, or an
      // override becomes a way to hand run_checks zero stages and let the
      // post-loop gate go missing entirely.
      assertRunChecksUsable(run.tools, checks, run.worktree, where);
      run = { ...run, checks };
    }
    const root = resolve(spec.root ?? defaultRoot);
    if (!existsSync(root)) {
      throw new Error(`job '${spec.id}': root does not exist: ${root}`);
    }
    return { id: spec.id, spec, run, root };
  });
}
