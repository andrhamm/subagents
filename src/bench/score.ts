import type { Envelope } from "../envelope";
import type { Fixture } from "./fixture";

export interface BenchRow {
  fixture: string;
  tier: string;
  model: string;
  status: string;
  /** null when the fixture has no checks — nothing gated. */
  gatePassed: boolean | null;
  oraclePass: boolean;
  failures: string[];
  turns: number;
  wallSecs: number;
  tokens: number;
  truncations: number;
}

/** Score one envelope against one oracle. Collects every failure — a bench
 * row that says only "failed" teaches nothing. */
export function scoreEnvelope(fx: Fixture, env: Envelope): { pass: boolean; failures: string[] } {
  const failures: string[] = [];
  const o = fx.oracle;

  if (o.status !== undefined && env.status !== o.status) {
    failures.push(`status: expected '${o.status}', got '${env.status}'`);
  }
  if (o.checks_pass !== undefined) {
    const passed = env.test?.passed ?? false;
    if (passed !== o.checks_pass) {
      failures.push(`checks_pass: expected ${o.checks_pass}, gate says ${env.test?.passed ?? "never ran"}`);
    }
  }
  if (o.files_changed !== undefined) {
    const got = [...(env.files_changed ?? [])].sort();
    const want = [...o.files_changed].sort();
    if (JSON.stringify(got) !== JSON.stringify(want)) {
      failures.push(`files_changed: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
    }
  }
  const summary = env.summary ?? "";
  for (const src of o.summary_must_match ?? []) {
    if (!new RegExp(src).test(summary)) failures.push(`summary_must_match missed: ${src}`);
  }
  for (const src of o.summary_must_not_match ?? []) {
    if (new RegExp(src).test(summary)) failures.push(`summary_must_not_match hit: ${src}`);
  }
  return { pass: failures.length === 0, failures };
}
