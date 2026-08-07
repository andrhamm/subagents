import {
  cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";

interface MetaConfig {
  files?: { solution?: string[]; test?: string[]; exemplar?: string[] };
}

async function bunTestPasses(dir: string): Promise<boolean> {
  const proc = Bun.spawn(["bun", "test"], { cwd: dir, stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => proc.kill(9), 30_000);
  const code = await proc.exited;
  clearTimeout(timer);
  return code === 0;
}

/**
 * Import practice exercises from a local checkout of an Exercism track into
 * bench fixtures. Every import is proven before it exists: the exercise's
 * own canonical solution (exemplar) must pass its own tests under
 * `bun test`, or the exercise is skipped with a reason — a fixture whose
 * oracle cannot go green is not a benchmark, it is a trap.
 * Network-free by design; the CLI entry below does the cloning.
 */
export async function importTrack(
  trackDir: string,
  dest: string,
  opts: { count?: number; slugs?: string[] } = {},
): Promise<{ imported: string[]; skipped: Array<{ slug: string; reason: string }> }> {
  const practiceDir = join(trackDir, "exercises", "practice");
  if (!existsSync(practiceDir)) {
    throw new Error(`not an Exercism track checkout: ${practiceDir} missing`);
  }
  let slugs = readdirSync(practiceDir).sort();
  if (opts.slugs) slugs = slugs.filter((s) => opts.slugs!.includes(s));

  const imported: string[] = [];
  const skipped: Array<{ slug: string; reason: string }> = [];

  for (const slug of slugs) {
    if (opts.count !== undefined && imported.length >= opts.count) break;
    try {
      const src = join(practiceDir, slug);
      const metaPath = join(src, ".meta", "config.json");
      if (!existsSync(metaPath)) {
        skipped.push({ slug, reason: "no .meta/config.json" });
        continue;
      }
      const meta = JSON.parse(await Bun.file(metaPath).text()) as MetaConfig;
      const solutions = meta.files?.solution ?? [];
      const tests = meta.files?.test ?? [];
      const exemplars = meta.files?.exemplar ?? [];
      if (solutions.length === 0 || tests.length === 0 || exemplars.length !== solutions.length) {
        skipped.push({ slug, reason: "unusable .meta files layout" });
        continue;
      }

      // Check for README before proof step.
      if (!existsSync(join(src, "README.md"))) {
        skipped.push({ slug, reason: "no README.md" });
        continue;
      }

      // Prove the oracle: exemplar over stub, then bun test must pass.
      const proof = mkdtempSync(join(tmpdir(), `subagents-exemplar-${slug}-`));
      try {
        for (const t of tests) {
          mkdirSync(join(proof, dirname(t)), { recursive: true });
          cpSync(join(src, t), join(proof, t));
        }
        for (let i = 0; i < solutions.length; i++) {
          mkdirSync(join(proof, dirname(solutions[i]!)), { recursive: true });
          cpSync(join(src, exemplars[i]!), join(proof, solutions[i]!));
        }
        if (!(await bunTestPasses(proof))) {
          skipped.push({ slug, reason: "exemplar fails under bun test (jest-compat gap)" });
          continue;
        }
      } finally {
        rmSync(proof, { recursive: true, force: true });
      }

      // Emit the fixture: stub + tests + README, never .meta (no cribs).
      const fxDir = join(dest, slug);
      rmSync(fxDir, { recursive: true, force: true });
      const filesDir = join(fxDir, "files");
      for (const f of [...solutions, ...tests]) {
        mkdirSync(join(filesDir, dirname(f)), { recursive: true });
        cpSync(join(src, f), join(filesDir, f));
      }
      cpSync(join(src, "README.md"), join(filesDir, "README.md"));
      writeFileSync(join(fxDir, "fixture.yaml"), [
        `# Imported from Exercism (${slug}); oracle proven via exemplar. Not vendored — regenerate with import-exercism.`,
        `task: "Implement the exercise described in README.md so the tests pass. The test file names the entry points."`,
        `tools: [read_file, grep, list_dir, edit_file, write_file, run_checks]`,
        `checks:`,
        `  - { name: tests, cmd: "bun test" }`,
        `oracle:`,
        `  status: ok`,
        `  checks_pass: true`,
        // The importer knows the solution paths; without this a delegate
        // that edits the test file instead of the solution scores clean —
        // checks_pass alone doesn't say WHICH file changed. Exercise-relative
        // paths land root-relative after the files/ copy, matching what
        // collectChanges reports.
        `  files_changed: [${solutions.map((f) => JSON.stringify(f)).join(", ")}]`,
        ``,
      ].join("\n"));
      imported.push(slug);
    } catch (e) {
      skipped.push({ slug, reason: `unexpected error: ${e instanceof Error ? e.message : String(e)}` });
    }
  }

  return { imported, skipped };
}

// CLI entry: clone-then-import. Kept thin so tests never need the network.
if (import.meta.main) {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      track: { type: "string", default: "typescript" },
      count: { type: "string", default: "10" },
      dest: { type: "string", default: "bench/fixtures-exercism" },
      slugs: { type: "string" },
    },
  });
  const clone = mkdtempSync(join(tmpdir(), "subagents-exercism-"));
  const url = `https://github.com/exercism/${values.track}`;
  const proc = Bun.spawn(["git", "clone", "--depth", "1", url, clone],
    { stdout: "inherit", stderr: "inherit" });
  if ((await proc.exited) !== 0) {
    console.error(`clone failed: ${url}`);
    process.exit(1);
  }
  try {
    const r = await importTrack(clone, values.dest, {
      count: Number(values.count),
      ...(values.slugs ? { slugs: values.slugs.split(",") } : {}),
    });
    console.log(`imported ${r.imported.length}: ${r.imported.join(", ")}`);
    for (const s of r.skipped) console.log(`skipped ${s.slug}: ${s.reason}`);
  } finally {
    rmSync(clone, { recursive: true, force: true });
  }
}
