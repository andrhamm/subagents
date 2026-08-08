# subagents

[![CI](https://github.com/andrhamm/subagents/actions/workflows/ci.yml/badge.svg)](https://github.com/andrhamm/subagents/actions/workflows/ci.yml)

Delegate scoped coding tasks — bulk triage, log digests, small test-gated
fixes — to a local or self-hosted model. The orchestrating agent pays a small
fixed context cost instead of reading everything itself.

## Why

Native subagents already isolate context; what they don't solve is **price** —
every subagent token is billed at frontier rates. A local model can absorb that
work for free. The trick is getting the result back without re-reading it all:
piping a local model's output through the orchestrator costs *more* context
than doing the work directly.

So `subagents` runs the entire agentic loop itself — reads, searches, edits,
checks — and returns one JSON envelope, bounded at ~1,200 characters. The full
transcript lands on disk; the orchestrator reads it only when something fails.

Measured during design: a repo-wide triage burned **165,362 delegate tokens and
returned ~850 to the caller** — about 195:1. A delegated one-line fix burns
~2,600–3,500 delegate tokens and returns a ~600-character envelope carrying the
diffstat and the test-gate verdict, measured across six models from 4.6B up
([bench](docs/bench/2026-08-06-lan-host.md)).

## Quick start

Needs [Bun](https://bun.sh) ≥ 1.3 and any OpenAI-compatible server — LM Studio,
Ollama, vLLM, llama.cpp server, LiteLLM, OpenRouter. No runtime npm
dependencies.

```bash
git clone https://github.com/andrhamm/subagents && cd subagents
cp subagents.example.yaml subagents.yaml   # point base_url at your server, pick models
bun src/cli.ts run --profile digest \
  --task "What does src/text.ts export? Cite line numbers." \
  --root .
```

The config defines **providers** (endpoints), **tiers** (a model on a
provider), and **profiles** (a tool allowlist plus a tier) — the example
config ships read-only `digest`/`audit` and check-gated `fix`. One line
lands on stdout; this is a live run of the command above, pretty-printed:

```json
{
  "status": "ok",
  "summary": "`src/text.ts` exports two functions:\n\n* `markIfCut(text, limit)` (line 6)\n* `markIfCutTail(text, limit)` (line 15)",
  "turns": 2,
  "wall_secs": 11.2,
  "context": { "peak_prompt_tokens": 767, "limit": 131072, "pressure": 0.01 },
  "truncations": 0,
  "local_tokens": 1444,
  "transcript": "/tmp/subagents-1786140017961.json"
}
```

Exit `0` means status `ok` and the check gate (if any) passed. Exit `2` means
the run finished but something failed — an envelope is still on stdout; read
it before treating the run as lost. Exit `1` means it never started: nothing
on stdout, the error on stderr. `bun run build` compiles a single-file binary
to `dist/subagents`.

Many jobs, one rollup envelope: `subagents batch --jobs jobs.yaml` (see
[jobs.example.yaml](jobs.example.yaml)). Fixture benchmarking:
`subagents bench --tiers cheap,strong`.

Orchestrating from Claude Code? Install the plugin — it ships a skill that
teaches the agent when and how to delegate:

```
/plugin marketplace add andrhamm/subagents
/plugin install subagents@subagents
```

## What ships today

Everything below is verified against live models, not just the test suite.

- **The agentic loop** — `subagents run` drives tool-calling turns against any
  OpenAI-compatible endpoint, configured by providers, tiers, sampling presets,
  and per-profile tool allowlists in one YAML file
- **Claude-Code-faithful read tools** — line-numbered paged `read_file`,
  deterministic `grep`/`glob`/`list_dir`; every cap and exclusion is reported,
  never silent
- **Worktree-confined writes** — `edit_file` (exact-substring replace, unique
  match, read-before-edit) and `write_file`, in a git worktree detached at
  HEAD: the delegate never touches your working tree and sees your last
  commit, not uncommitted changes
- **A staged check gate** — a write profile's ordered `checks` (or `test_cmd`
  sugar for one stage) run in the worktree after the loop, stopping at the
  first failure; the envelope reports every stage's verdict, and a failed gate
  keeps the worktree so the diff can be salvaged. `run_checks` lets the
  delegate run the same pipeline mid-loop (capped at 3 calls; the harness
  re-verifies after the loop regardless), and every write gets a same-turn
  syntax check on `.ts`/`.tsx`/`.js`/`.jsx` content
- **A deadline gate** — `--deadline-secs` stops the loop before a turn that
  would overrun it, returning a partial envelope instead of being killed with
  nothing on stdout
- **Context telemetry** — on LM Studio providers (`kind: lmstudio` in the
  config) the envelope reports the loaded model's context length and
  `pressure`, peak prompt tokens over that limit; a run that exceeded the
  window says so, with token counts, instead of surfacing a generic HTTP 400
- **`subagents batch`** — N jobs from a YAML file, one rollup envelope. Jobs
  group by (provider, model) so each model loads once; `max_in_flight` caps
  per-provider fan-out; `--escalate-tier` re-runs failed or truncation-blind
  jobs (reads cut short by output caps) on a stronger tier; infra failures
  retry once on the same tier first; `--progress` maintains a pollable
  state file
- **`subagents bench`** — deterministic fixtures with oracles and baseline
  regression gating; measures harness deltas, not model capability
  ([bench/README.md](bench/README.md))

## Planned, not built

- `bash` as a model-callable tool (the harness-run check gate exists;
  arbitrary commands do not)
- An MCP client for external tools
- The LM Studio tool-use capability probe

## Which model should I run?

**→ [Recommended Models by Hardware Profile](https://github.com/andrhamm/subagents/wiki/Recommended-Models)**

Model picks from ~8 GB to 80 GB+, measured throughput and accuracy, per-family
sampling parameters, and the operating gotchas that cost the most debugging
time.

The short version: the model **must support tool calling**, or it will loop
uselessly and produce nothing. On one installation surveyed, 11 of 27 installed
models could not — including well-regarded coding models whose chat templates
predate the feature. On LM Studio, check before spending a run (for servers
without a capability API, the wiki gives a one-turn test):

```bash
curl -s http://localhost:1234/api/v0/models \
  | jq -r '.data[] | select(.capabilities // [] | index("tool_use")) | .id'
```

## Design principle

Every failure blamed on the models during prototyping turned out to be the
harness being **less careful than Claude Code's own tools**: unnumbered reads
made citations drift, silent truncation looked like laziness, and a required
terminator tool discarded a correct answer as an error.

**Mirror Claude Code's tool semantics exactly. Never truncate silently.** With
that fixed, a 4.6B model produced exact line citations and fabricated none.

Full design and the measurements behind it: [docs/design.md](docs/design.md).

## License

MIT
