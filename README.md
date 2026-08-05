# subagents

Delegate scoped coding tasks to any OpenAI-compatible model, so an orchestrating
agent pays a small fixed context cost instead of reading everything itself.

> **Status: design phase.** This repo currently contains the design, the Claude
> Code plugin scaffolding, and the usage skill. **The CLI is not implemented yet.**

## Why

Native subagents already isolate context — their intermediate work never reaches
the caller. What they don't solve is **price**: every subagent token is billed at
frontier rates. A local or self-hosted model can absorb that input for free.

The naive workaround — piping a local model's output back through the orchestrator
— costs *more* context than doing the work directly. So instead: a CLI that runs
the entire agentic loop against a configured model, reads and edits files itself,
and returns a small JSON envelope. The transcript lands on disk and is read only
when something fails.

Measured on a repo-wide triage during design: **165,362 tokens burned on the
delegate, ~850 returned to the caller** — about 195:1.

## What it will do

- Run an agentic tool-calling loop against any OpenAI-compatible endpoint —
  LM Studio, Ollama, vLLM, llama.cpp server, LiteLLM, OpenRouter
- Give the delegate Claude-Code-faithful tools: line-numbered paged reads,
  uniqueness-checked edits, grep, glob, bash
- Optional external tools over MCP, under a strict read-only allowlist
- Isolate writes in a git worktree behind a test gate
- Return a small envelope: status, summary, diffstat, test result, context
  pressure, truncation count, transcript path
- Benchmark any model on *agentic loop* tasks against deterministic ground truth

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

## Install (once implemented)

```
/plugin marketplace add andrhamm/subagents
/plugin install subagents@subagents
```

## License

MIT
