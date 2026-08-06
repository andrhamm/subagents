# subagents

Delegate scoped coding tasks to any OpenAI-compatible model, so an orchestrating
agent pays a small fixed context cost instead of reading everything itself.

> **Status: read-only loop and worktree-confined writes ship; bash, MCP, and
> batch are planned.** `subagents run` works today against any OpenAI-compatible
> endpoint, verified against a live model. See [What ships today](#what-ships-today)
> below for the exact boundary.

## Why

Native subagents already isolate context — their intermediate work never reaches
the caller. What they don't solve is **price**: every subagent token is billed at
frontier rates. A local or self-hosted model can absorb that input for free.

The naive workaround — piping a local model's output back through the orchestrator
— costs *more* context than doing the work directly. So instead: a CLI that runs
the entire agentic loop against a configured model, reads files itself (write
support is planned, see below), and returns a small JSON envelope. The
transcript lands on disk and is read only when something fails.

Measured on a repo-wide triage during design: **165,362 tokens burned on the
delegate, ~850 returned to the caller** — about 195:1.

## What ships today

- An agentic tool-calling loop against any OpenAI-compatible endpoint —
  LM Studio, Ollama, vLLM, llama.cpp server, LiteLLM, OpenRouter — via
  `subagents run`
- Config with providers, tiers, sampling presets, and per-profile tool
  allowlists
- Claude-Code-faithful read-only tools: line-numbered paged reads (`read_file`),
  deterministic search (`grep`, `glob`, `list_dir`) with full omission
  reporting for every cap and exclusion, never a silent one
- A deadline gate: pass `--deadline-secs` and the loop stops before a turn
  that would overrun it, returning a partial result instead of being killed
- A small, size-bounded JSON envelope (status, summary, turns, wall time,
  context usage, truncation count, transcript path) plus the full transcript
  on disk
- Write support: `edit_file` (exact-substring replace, unique match, read-before-edit)
  and `write_file` (create, or overwrite-after-read), confined to a git worktree
  detached at HEAD — the delegate never touches your working tree, and sees your
  last commit, not uncommitted changes
- A test gate: a write profile's `test_cmd` runs in the worktree after the loop;
  the envelope reports the verdict, and a failed gate keeps the worktree so the
  diff can still be inspected

## What's planned, not built

- `bash` as a model-callable tool (the harness-run test gate exists; arbitrary
  commands do not)
- An MCP client for external tools
- The LM Studio adapter (capability probe, `context.limit`/`context.pressure`
  — both are `null` today because nothing populates them yet)
- Batch scheduling across multiple jobs and models
- The agentic-loop benchmark harness

## Which model should I run?

**→ [Recommended Models by Hardware Profile](https://github.com/andrhamm/subagents/wiki/Recommended-Models)**

Model picks for hardware from ~8 GB up to 80 GB+, measured throughput and accuracy
figures, per-family sampling parameters, and the operating gotchas that cost the most
debugging time.

The short version: the model **must support tool calling** or it will loop uselessly
producing nothing — and on one installation surveyed, 11 of 27 installed models could
not, including several well-regarded coding models whose chat templates predate the
feature. Check first:

```bash
curl -s http://localhost:1234/api/v0/models \
  | jq -r '.data[] | select(.capabilities // [] | index("tool_use")) | .id'
```

## Design principle

Every failure initially blamed on the models during prototyping turned out to be
the harness being **less careful than Claude Code's own tools**: unnumbered reads
made citations drift, silent truncation looked like laziness, and a required
terminator tool discarded a correct answer as an error.

**Mirror Claude Code's tool semantics exactly. Never truncate silently.** With
that fixed, a 4.6B model produced exact line citations and fabricated none.

See [docs/design.md](docs/design.md) for the full design and the measurements
behind it.

## Install (once published)

```
/plugin marketplace add andrhamm/subagents
/plugin install subagents@subagents
```

## License

MIT
