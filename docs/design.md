# subagents — design

Delegate scoped coding tasks to any OpenAI-compatible model, so an orchestrating
agent (Claude Code, or anything else) pays a small fixed context cost instead of
reading everything itself.

Status: the read-only loop, write tools, worktree isolation, the staged
check gate, batch scheduling, and benchmark harness below ship — config,
the agentic loop, all seven tools (four read-only, two write, one
check-runner), the deadline gate, worktree lifecycle, staged check
execution, the envelope, batch (model grouping, concurrency evidence, the
progress file, the batch deadline, and escalation), and benchmark (fixture
format, oracle scoring, baseline gating). The read-only loop, the write
loop, and a single-stage test gate are verified against a live model
([bench](bench/2026-08-06-lan-host.md)); the staged `checks:` pipeline, the
`run_checks` tool, and the bench suite were live-verified 2026-08-07 on the
same host — a 4.6B delegate ran read → edit → `run_checks` (both stages
green) → stop in 3.5s, and `subagents bench --tiers cheap` passed both
committed fixtures — honoring this repo's rule that a wire-shape change
earns a live check before it's trusted. The
**Batch scheduling** and **Benchmark** sections below describe shipped
behavior, not a plan. The MCP client, the LM Studio adapter, and `bash` are
designed here but not built. `src/` is authoritative over this document
wherever they disagree. Not pushed anywhere yet.

## The problem

A capable orchestrating agent burns most of its context on *input* — reading
files, logs, and search results. Native subagents already solve context
isolation: their intermediate work never reaches the caller. What they don't
solve is **price**: every subagent token is billed at frontier rates.

A local or self-hosted model can absorb that input for free. The catch is that
no mainstream agent harness lets you point a subagent at an arbitrary endpoint,
and the naive workaround — pipe the model's output back through the orchestrator
— costs *more* context than doing the work directly.

So: a CLI the orchestrator shells out to. It runs the whole agentic loop against
a configured model, writes files directly, and returns a small envelope. Full
transcript lands on disk and is read only when something fails.

## What we measured

Real numbers from a throwaway prototype, against `qwen3-coder-next` (80B) and
`google/gemma-4-e2b` (4.6B) on LM Studio.

Task: enumerate every route in a 494-line TypeScript file that validates a
request body, with line numbers. Ground truth from `grep`: 6 routes.

| Model | Params | Recall | Citations | Fabricated | Wall | Terminated by |
|---|---|---|---|---|---|---|
| `qwen3-coder-next` | 80B | 6/6 | exact | none | 34.2s | tool call |
| `google/gemma-4-e2b` | 4.6B | 5/6 | exact | none | 13.4s | prose |

Token accounting on a broader repo-wide triage: **165,362 tokens burned on the
delegate, ~850 returned to the caller** — a ~195:1 ratio. Doing the same reading
directly would have pinned 40k+ tokens of file contents into the orchestrator's
context permanently.

A 4.6B model produced exact line citations with zero fabrication. That is the
single most important result, and it only happened after the harness bugs below
were fixed.

## The core principle

Every failure initially attributed to the models turned out to be the harness
being **less careful than Claude Code's own tools**:

1. `read_file` returned unnumbered content → the model counted lines by hand and
   its citations drifted 4–8 lines late. Fixed by `cat -n` style numbering;
   citations became exact.
2. Tool results were silently truncated at 8000 chars → a 494-line file was cut
   at line 190, hiding 4 of 6 answers. This looked exactly like model laziness.
   The model even said *"the file appears to be truncated"* and was ignored.
3. The loop required a `finish` tool call and stored terminal prose as a 300-char
   error string → a correct 5/6 answer was recorded as a failure and discarded.

**Design rule: mirror Claude Code's tool semantics exactly. Any deviation is a
bug until proven otherwise.** Corollary: never truncate silently, anywhere.

## Architecture

```
src/
  cli.ts               arg parsing, config resolution, dispatch; bench: fixture
                       glob resolution, baseline comparison
  config.ts            schema + load/merge (providers, tiers, sampling, profiles)
  loop.ts              provider-agnostic agentic loop
  envelope.ts          result envelope
  transcript.ts        full message-array persistence
  backends/
    base.ts            OpenAI-compatible floor: POST /v1/chat/completions, GET /v1/models
    lmstudio.ts        extends base: capability probe, residency, TTL, device awareness
  tools/
    registry.ts        profile → tool set resolution, schema assembly
    read.ts            read_file with line numbering, paging, truncation markers
    search.ts          grep, glob, list_dir with caps and explicit omission notices
    edit.ts            edit_file (exact-substring replace, unique-match check)
    write.ts           write_file (read-before-overwrite, path safety)
    checks.ts          run_checks (staged pipeline, stop-at-failure, tier-capped)
    syntax.ts          language-specific parse check (ts/tsx/js/jsx detect)
    paths.ts           path resolution, confinement, realpath
    types.ts           shared tool types (ToolResult, ToolContext, Tool)
  bench/
    fixture.ts         fixture loading and validation
    score.ts           oracle-based scoring (recall, precision, citations, fabrication)
    run.ts             fixture execution and scoring driver
    import-exercism.ts Exercism track fixture importer with exemplar validation
```

Planned but not built: `bash` tool (command exec with timeout + allow/deny),
MCP client (Streamable-HTTP to external tool servers), the LM Studio tool-use
capability probe (the adapter's context-limit probe —
`context.limit`/`context.pressure` — landed in `src/backends/lmstudio.ts`).

Runtime is Bun (TypeScript, no build step, `bun build --compile` for a
single-file binary).

Each unit is independently testable: the loop takes a backend and a tool
registry as arguments and knows nothing about HTTP or the filesystem; tools take
a root and return strings; backends take a request and return a response.

## Tool contract

This is the load-bearing part of the whole design.

| Tool | Semantics |
|---|---|
| `read_file` | Line-numbered output. `offset`/`limit`, default 2000 lines. If more remains, append an explicit marker naming the range shown, the count withheld, the `offset` to continue from, and an instruction not to conclude anything about the file yet. |
| `edit_file` | Exact-substring replace. `old_string` must match exactly once, or the tool returns an error explaining which (not found / N occurrences). Optional `replace_all`. |
| `write_file` | Whole-file write. Refuses to overwrite a file not yet read in this session. |
| `grep` | Regex + optional glob filter. Returns `path:line:text`. Capped, with an explicit truncation notice naming how many matches were withheld. |
| `glob` | Shell glob. Capped, explicit notice. |
| `list_dir` | Recursive file list. Capped, explicit notice. |
| `run_checks` | Zero-argument. Runs the profile's caller-authored `checks` (or `test_cmd` sugar) in order, stopping at the first failure. Capped at 3 calls per run — the post-loop gate re-verifies regardless. |
| `bash` | (planned) Timeout, cwd confined to root, config allow/deny patterns. |

**Termination:** an assistant message with content and no tool calls means done.
No terminator tool is required. A `finish` tool may be *offered* when structured
output is wanted, but the loop must never depend on it being called.

**Path safety:** every path is resolved with realpath and rejected if it escapes
the configured root.

## Config

```yaml
providers:
  local: { base_url: http://127.0.0.1:1234/v1, kind: lmstudio }
  lan:   { base_url: http://lan-host:1234/v1, kind: lmstudio }
  vllm:  { base_url: http://gpu-host:8000/v1, kind: openai }

sampling:                      # per model family; there is no universal setting
  gemma-factual:      { temperature: 0.3, top_p: 0.95, top_k: 64 }
  qwen-nonthinking:   { temperature: 0.7, top_p: 0.8,  top_k: 20 }
  mistral:            { temperature: 0.0 }

tiers:
  cheap:  { provider: local, model: google/gemma-4-e2b, sampling: gemma-factual }
  strong: { provider: lan,   model: qwen3-coder-next,   sampling: qwen-nonthinking }

profiles:                      # the configurable allowlist
  digest: { tools: [read_file, glob, grep], tier: cheap }
  edit:   { tools: [read_file, glob, grep, edit_file, bash], tier: strong,
            worktree: true, test_cmd: "npm test" }

mcp:                           # external tool servers, optional
  code-search:
    url: http://127.0.0.1:5051/mcp
    tools:                     # strict allowlist; never the whole server
      - name: search
        caps: { max_results: 10 }
      - name: read_file
        caps: { max_lines: 200 }
```

Sampling presets matter more than they look: wrong parameters produce wrong
results that look real. Qwen thinking models forbid greedy decoding; Mistral's
own examples use it. There is no universal default, so families are named
explicitly and the shipped presets cite their source.

**"When present" semantics:** MCP tools are probed at startup. If a server is
unconfigured or unreachable, its tools are silently omitted from the schema and
the omission is recorded in the envelope. A missing tool server degrades the run;
it never fails it.

## Envelope

Small, stable, and the only thing the orchestrator pays for:

```json
{
  "status": "ok | stopped | budget | error",
  "summary": "the delegate's final message",
  "turns": 4,
  "wall_secs": 12.0,
  "files_changed": ["src/rate-limit.ts"],
  "diffstat": "1 file changed, 1 insertion(+), 1 deletion(-)",
  "test": { "ran": true, "passed": true, "cmd": "npm test" },
  "context": { "peak_prompt_tokens": 21628, "limit": 32768, "pressure": 0.66 },
  "truncations": 0,
  "tools_omitted": [],
  "local_tokens": 165362,
  "transcript": "/path/to/transcript.json"
}
```

Shipped as a single pretty-printed JSON object (the full message array plus
model/task/status/usage), not a `.jsonl` stream.

This is the target shape; today's envelope (`src/envelope.ts`) has most of it:
`status`, `summary`, `detail`, `turns`, `wall_secs`, `context`, `truncations`,
`local_tokens`, `transcript`, `files_changed`, `diffstat`, `test`, `checks`,
and `worktree` now exist for write runs — `checks` carries one verdict per
configured stage (`name`, `passed`, `timedOut`); `test` stays the overall
pass/fail regardless of stage count. `status` is one of `ok`, `max_turns`,
`budget`, `deadline`, `error` — not `stopped`. `tools_omitted` still doesn't
exist because the MCP client doesn't. And `context.limit`/`context.pressure`
are populated for `kind: lmstudio` providers — after the loop,
`src/backends/lmstudio.ts` asks `/api/v0/models/{id}` for the loaded model's
context length (preferring `loaded_context_length`, the serving config, over
`max_context_length`), memoized per (provider, model) so a batch group costs
one GET. They stay `null` — unknown, not "no pressure" — for `kind: openai`
providers or when the probe fails.

`truncations` and `context.pressure` exist because of failure #2 above: the
orchestrator must be able to see that the delegate was working blind, without
reading the transcript.

`transcript` persists the **full message array**, not just API responses. During
this session a question came up — had the files changed underneath the model? —
that the transcript could not answer, because only responses had been saved.

## Backends

The generic floor is `POST /v1/chat/completions` with `tools`, plus
`GET /v1/models`. That covers LM Studio, Ollama, vLLM, llama.cpp server,
LiteLLM, OpenRouter, and hosted providers.

Tool-calling support varies wildly across models on those endpoints, so the loop
must fail loudly and early rather than spinning: if the first response contains
no tool calls and no usable content, report a capability problem, not a task
failure.

The `lmstudio` backend adds, all behind detection:

- `GET /api/v0/models` → `capabilities: ["tool_use"]`, `max_context_length`,
  `state`. Checking this *before* a run is the cheapest possible way to avoid
  wasting one. Nothing else offers it.
- Residency control via `lms load/unload/ps`, including context length and TTL.
- Device awareness. Two traps worth encoding: the same model key can exist on
  two devices with different builds and parameter counts, and a federated
  instance may load on a remote device even when given an unprefixed local path.
  Always verify where a model actually landed before trusting a timing.

Observed but unverified elsewhere: LM Studio held two models resident on one
host simultaneously, contradicting a "one resident model" assumption. Residency
limits should be discovered, not assumed.

## Safety

Writes are the risk, and the delegate has no permission system of its own.

- **Worktree isolation** default-on for any profile with write tools. The
  delegate edits an isolated tree; the orchestrator inspects a diff.
- **Test gate** — the profile's ordered `checks` (or `test_cmd` sugar for a
  single stage) run in the worktree after edits, stopping at the first
  failure. Failure is *reported, not reverted*: with worktree isolation the
  diff is the deliverable, and a failed-but-close diff is salvageable by the
  orchestrator. (Earlier drafts said "revert"; that predates
  worktree-by-default.)
- **Command text is caller-authored, never model-authored.** `checks[].cmd`
  (or `test_cmd`) lives in config or a job spec, set by the orchestrator.
  `run_checks` takes zero arguments — a delegate can pull the trigger the
  caller loaded, but it never writes the command that runs.
- **Never expose write-capable external tools.** An MCP server may offer
  destructive operations alongside search; the allowlist is explicit per tool,
  never per server.
- **Path confinement** on every filesystem tool.
- **Bash allow/deny** patterns, with a timeout.

## Benchmark

A first-class feature, not an afterthought: score any model on *agentic loop*
tasks against deterministic ground truth. Published benchmarks measure one-shot
extraction; nothing measures whether a model can hold a 12-turn tool loop, which
is the only thing that matters here. **This suite measures the harness, not the
models** (see [bench/README.md](../bench/README.md) for the one rule): relative
deltas across harness variants stay valid; absolute scores are contaminated
because public exercises live in every model's training data.

Each fixture is a directory: `fixture.yaml` (task, tools, optional ordered
`checks`, oracle) plus `files/` — the repo the delegate works in, copied
to a throwaway git repo per run. Oracles: expected `status`, gate verdict
(`checks_pass`), exact `files_changed`, `summary_must_match` regexes
(citations), `summary_must_not_match` regexes (fabrication traps).

Scoring reports recall, precision, citation accuracy, fabrication count, turns,
wall time, and tokens. Raw responses persist before scoring, so a scoring bug
costs a re-score rather than a re-run. Fixtures live in `bench/fixtures/`
(committed, hand-authored) and `bench/fixtures-exercism/` (generated by the
importer, each oracle proven by running the exercise's canonical solution
under `bun test`). Results JSONL persists to `--out`, with optional `--baseline`
gating regression detection (a fixture that was passing now fails = exit 2).
Per-turn logs (`--log-dir`) emit JSONL in the same format `subagents run --log`
and batch jobs do.

## Batch scheduling

A blocking CLI call is free real estate: the orchestrator waits on it regardless, so
every scheduling decision made *inside* the harness costs zero orchestrator turns.
A decision left to the caller is paid for twice — once in tokens, once in latency.

So the harness should own a work queue, not just run one task. `subagents batch`
takes N jobs and returns one rollup. Three things follow:

1. **Model grouping.** Sort jobs by model so each loads exactly once, runs all its
   jobs, then yields. "Never iterate models without explicit unload/load" stops being
   an operating rule a human must remember and becomes a scheduling invariant.
2. **Automated escalation.** The two-pass recipe currently needs the caller to read
   cheap-tier results and re-dispatch the ambiguous ones. Inside the scheduler, one
   call covers the whole sweep-then-escalate cycle. This is the larger economy: one
   job costs ~850 tokens of envelope, so thirty dispatched individually cost ~25k
   across thirty turns versus one batch returning a rollup.
3. **Capacity-aware residency.** `--estimate-only` answers "will this fit?" in about a
   second. The scheduler asks, because the answer decides whether it can hold a cheap
   and a strong model resident at once and run both passes concurrently, or must
   serialize with swaps.

### Concurrency: configured, evidenced, tuned by the caller

The throughput ceiling is a property of host × model × prompt shape, not knowable in
advance. Rather than build an adaptive controller — hard to test, and prone to
oscillating on a shared host — split the responsibility three ways:

1. **Known hosts declare it.** Where the ceiling has been measured, config states it:
   `providers.<name>.max_in_flight`. On LM Studio the loaded model's own parallelism is
   also readable (`lms ps` reports `PARALLEL`) and caps the useful value.
2. **Unknown hosts get a conservative default.** `max_in_flight: 2` — measured to
   capture most of the available gain (1.68× of a 1.95× peak) with little risk.
3. **The harness reports evidence; the caller tunes.** Every run returns what actually
   happened at the configured level, and the usage skill teaches the orchestrator how
   to read it and change the setting.

This is why the envelope carries concurrency evidence rather than just a duration:

```json
"concurrency": {
  "configured": 4, "achieved_throughput_per_min": 48.0,
  "latency_p50_secs": 5.6, "latency_max_secs": 11.7,
  "queue_wait_secs": 0.2, "timeouts": 0, "errors": 0
}
```

A widening spread between `latency_p50` and `latency_max` with no throughput gain is
the signature of queueing rather than parallelism — the same signature observed at
8-way on a host that peaked at 4. Rising `queue_wait` says the same thing. Those are
legible to a reasoning caller in a way they are not to a heuristic.

Two cautions the skill must carry: a measured ceiling goes stale the moment another
user loads something on a shared host, and calibrating against cold requests
fabricates the speedup outright — one early measurement reported an 8.7× gain whose
baseline was a cold request including model load.

**Batch mode must be background-capable from the start.** Bash tool invocations cap
out around 600s, and any batch worth batching exceeds that. Long runs need a progress
file the caller can poll rather than a call it must block on.

## Deadlines: stop before you are killed

The caller invokes this through a shell tool with a hard wall-clock limit — commonly
120s by default and 600s maximum. **Being killed at that limit is the worst possible
outcome:** the caller gets truncated stdout, no envelope, and no transcript path, so it
cannot tell whether any work happened or where the evidence went. A degraded answer is
enormously better than no answer.

So the harness takes `--deadline-secs`, set by the caller to somewhat under the
shell timeout it used, and treats it as a budget it must not overrun. This is
the same principle as never truncating a tool result silently: a run that
stops early must *say* it stopped early, in a form the caller can act on.

**Check between turns, using observed durations.** After a couple of turns there is
real per-turn timing for this model, task, and prompt size. Before starting turn N+1,
stop if `elapsed + observed_worst_turn + wrapup_reserve > deadline`. Use the observed
**worst** turn, not the mean — the tail is what overruns. One measured run had turns of
2.3s and 30.2s in the same conversation.

**Clamp the per-request timeout too.** A 300s configured request timeout inside a 120s
deadline is incoherent: one slow call blows the budget even with between-turn checks.
Every request gets `min(configured_timeout, remaining_budget − wrapup_reserve)`.

**Reserve time to finish cleanly.** Writing the transcript and emitting the envelope is
not free. The reserve is what guarantees a valid envelope exists.

**Handle SIGTERM as a backstop (planned, not implemented).** Proactive budgeting is
primary, but if the process is signalled anyway, flush the transcript and emit an
envelope with `status: "interrupted"` rather than dying silently.

The envelope reports the stop honestly and tells the caller what to do:

```json
{ "status": "deadline",
  "detail": "stopped after 3 turns with 8s of a 120s budget left; worst observed turn was 30s",
  "summary": "<partial findings so far>",
  "turns": 3, "deadline_secs": 120, "transcript": "…" }
```

`status: "deadline"` is distinct from `ok`, `max_turns`, and `budget` because the caller's
remedy differs: re-run with a longer shell timeout, narrow the task, or move to batch
mode. A partial result the caller knows is partial is useful; one it mistakes for
complete is a defect of the same class as a silently truncated file read.

**In batch mode** the deadline means *stop starting new jobs*. Completed jobs keep their
envelopes and the rollup names the ones that never ran, so partial batch output stays
usable. A deadline above the shell maximum is a signal the caller wants background
execution — the harness should say so rather than accept a budget it cannot honor.

## Non-goals

- Replacing native subagents. Delegation suits work that is large, mechanical,
  verifiable, and repeated often enough for the token bill to matter.
- Long-horizon autonomous feature work.
- Reimplementing hooks, permission modes, or skills.
- An MCP server interface for this tool. Tool schemas would load into the
  orchestrator's context permanently, defeating the purpose. A CLI's output is
  an envelope we control.

## Open questions

1. Does a small model hold a **write** loop on real code? *Answered for the
   single-file case:* six models from 4.6B to 80B completed read → exact-match
   edit → gate-pass loops with zero caller-tree contamination
   ([bench](bench/2026-08-06-lan-host.md)). Still open for multi-file edits.
2. Where does context pressure actually bite on multi-file work at 128k+?
3. Is a repo map worth building, or do numbered paged reads plus grep suffice?
4. Should the orchestrator-side skill auto-route by task shape, or always be
   explicit about tier?
