import { describe, it, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig } from "../../src/config";
import { parseJobs, resolveJobs } from "../../src/batch/jobs";

const CFG = parseConfig(`
providers:
  local: { base_url: "http://127.0.0.1:1234/v1" }
tiers:
  cheap:  { provider: local, model: "small" }
  strong: { provider: local, model: "big" }
profiles:
  digest: { tools: [read_file, grep], tier: cheap }
`);

const JOBS_OK = `
jobs:
  - { profile: digest, task: "count the routes" }
  - { id: logs, profile: digest, task: "digest the log", tier: strong }
`;

describe("parseJobs", () => {
  it("parses jobs and assigns positional ids where omitted", () => {
    const specs = parseJobs(JOBS_OK);
    expect(specs.map((s) => s.id)).toEqual(["j1", "logs"]);
    expect(specs[1]!.tier).toBe("strong");
  });

  it("rejects a file without a non-empty jobs list", () => {
    expect(() => parseJobs("jobs: []\n")).toThrow(/non-empty 'jobs' list/);
    expect(() => parseJobs("- a\n")).toThrow(/non-empty 'jobs' list/);
  });

  it("rejects a job missing profile or task, naming its position", () => {
    expect(() => parseJobs("jobs:\n  - { task: x }\n")).toThrow(/jobs\[0\].*profile/);
    expect(() => parseJobs("jobs:\n  - { profile: digest }\n")).toThrow(/jobs\[0\].*task/);
  });

  it("rejects duplicate ids", () => {
    expect(() => parseJobs(
      "jobs:\n  - { id: a, profile: p, task: t }\n  - { id: a, profile: p, task: t }\n",
    )).toThrow(/duplicate id 'a'/);
  });

  // Ids flow unescaped into join(transcriptDir, `${id}.json`) — a permissive
  // id would let a job's transcript land outside transcriptDir.
  it("rejects an id containing a path separator", () => {
    expect(() => parseJobs("jobs:\n  - { id: \"a/b\", profile: p, task: t }\n"))
      .toThrow(/jobs\[0\]: id must match/);
  });

  it("rejects an id that traverses out of the transcript dir", () => {
    expect(() => parseJobs("jobs:\n  - { id: \"../evil\", profile: p, task: t }\n"))
      .toThrow(/jobs\[0\]: id must match/);
  });

  it("rejects a non-scalar id instead of silently coercing it via String()", () => {
    expect(() => parseJobs("jobs:\n  - { id: [1, 2], profile: p, task: t }\n"))
      .toThrow(/jobs\[0\]: id must match/);
  });
});

describe("resolveJobs", () => {
  it("resolves every job up front, applying per-job tier overrides", () => {
    const jobs = resolveJobs(CFG, parseJobs(JOBS_OK), process.cwd());
    expect(jobs[0]!.run.model).toBe("small");
    expect(jobs[1]!.run.model).toBe("big");
    expect(jobs[0]!.root).toBe(process.cwd());
  });

  it("fails fast, naming the job, before anything runs", () => {
    const bad = parseJobs("jobs:\n  - { id: oops, profile: ghost, task: t }\n");
    expect(() => resolveJobs(CFG, bad, process.cwd())).toThrow(/job 'oops'.*ghost/s);
  });

  it("rejects a job root that does not exist", () => {
    const gone = join(mkdtempSync(join(tmpdir(), "subagents-jobs-")), "nope");
    const specs = parseJobs(`jobs:\n  - { id: r, profile: digest, task: t, root: "${gone}" }\n`);
    try {
      expect(() => resolveJobs(CFG, specs, process.cwd())).toThrow(/job 'r'.*does not exist/s);
    } finally {
      rmSync(join(gone, ".."), { recursive: true, force: true });
    }
  });
});
