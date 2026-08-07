# Contributing

## Setup

```bash
bun install        # devDependencies only (typescript, @types/bun)
bun test           # the whole suite — no network, no models needed
bun run typecheck  # tsc --noEmit
```

Both must be green before any commit. There is no build step.

## The constraints that are not up for debate

- **Zero runtime dependencies.** `devDependencies` may contain only
  `@types/bun` and `typescript`. `Bun.YAML`, `Bun.spawn`, `Bun.Transpiler`,
  and global `fetch` cover what a library would.
- **Mirror Claude Code's tool semantics exactly.** Deviation is a bug until
  proven otherwise.
- **Never truncate silently.** Every capped output carries a marker naming
  what was withheld and how to continue.
- **Once a run starts, a valid envelope always reaches stdout.** Post-loop
  failures degrade a field honestly; they never cost the envelope.
- **Writes land only in a git worktree detached at HEAD.**

`docs/design.md` explains why each of these was earned rather than chosen;
`src/` is authoritative over every doc when they disagree.

## Wire-shape changes get a live check

The test suite's backends are scripted fakes, and a fake embodies the very
assumption being violated — a wire regression once passed 229 green tests
and died on turn 2 of the first live run. Any change to what goes over the
HTTP boundary (tool schemas, message shapes, envelope fields) needs one run
against a real OpenAI-compatible server (LM Studio, Ollama, vLLM) before
it's trusted. Say in your PR which server and model you used.

## Commit messages

Conventional Commits (`feat:`, `fix:`, `docs:`, `test:`, `refactor:`) —
releases are cut automatically from them by release-please, so the prefix
you choose decides the version bump. Subject line states what changed; the
body states why it was needed, not how the diff works.

## Measurements

Model measurements belong in the benchmark suite so they arrive comparable:
`bench/README.md` has the fixture format and the one rule for reading
results (the suite measures harness deltas, not model capability — public
exercises are contaminated). The wiki's
`docs/wiki/Recommended-Models.md` documents what a useful measurement
report contains.
