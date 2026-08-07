# subagents — project instructions

Bun/TypeScript CLI that delegates coding tasks to OpenAI-compatible local
models. `src/` is authoritative over every doc when they disagree.

## Commands

- Test: `bun test` (never a build step). Typecheck: `bun run typecheck`
  (needs `bun install` once — `tsc` comes from devDependencies).
- Run: `bun src/cli.ts run --profile <p> --task "…" --root <repo>`;
  batch: `bun src/cli.ts batch --jobs jobs.yaml`.
- `subagents.yaml` is gitignored local config; `subagents.example.yaml` is the
  committed template.
- A write profile's `checks` (ordered stages; `test_cmd` is sugar for one)
  gate the worktree after the loop, and `run_checks` lets the delegate run
  the same pipeline itself mid-loop. Both are new wire shapes — a tool
  schema and an envelope field — so the live-verification rule below still
  applies before either is trusted past the local suite's scripted backend.

## Hard constraints

- **Zero runtime dependencies.** devDependencies may contain only
  `@types/bun` and `typescript`. `Bun.YAML`, `Bun.spawn`, global `fetch`.
- **Mirror Claude Code's tool semantics exactly.** Deviation is a bug until
  proven otherwise.
- **Never truncate silently.** Every capped output carries a marker naming
  what was withheld and how to continue.
- **Once a run starts, a valid envelope always reaches stdout.** Post-loop
  failures degrade a field honestly; they never cost the envelope.
- **Writes land only in a git worktree detached at HEAD.**

## The lesson this repo keeps re-learning

Test fakes embody the assumption being violated. A wire-shape regression
(`tool_calls` echoed without `type: "function"`) passed 229 green tests and
died on turn 2 of the first live run — the same class of failure was caught
five times by reviewers during the read-only branch, never once by a test.
**Any change to wire message shapes gets verified against a live endpoint
before trusting the suite.** Live test host: LM Studio on `lan-host`
(192.0.2.10:1234 — use the IP; Bun's fetch can't resolve the bare
hostname). LM Studio silently serves unknown model ids with whatever model
is loaded — verify ids against `/api/v0/models` before trusting a run.

## Where things are

- Design: `docs/design.md`. Live bench results: `docs/bench/`.
- Model guidance (mirrors the GitHub wiki): `docs/wiki/Recommended-Models.md`.
- Orchestrator-facing usage skill: `skills/subagents/SKILL.md` — it is the
  first thing a consuming agent reads; keep its claims matched to `src/`.
- Do not add a git remote or push without explicit sign-off.
