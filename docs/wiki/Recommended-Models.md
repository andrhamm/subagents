# Recommended Models by Hardware Profile

Which local model to pick for delegated coding tasks, and what to expect from it.

> **Source and scope.** Figures below come from two separate measurement efforts on
> self-hosted LM Studio installations. Read the *What was actually measured* section
> before treating any number as a capability ranking — the two efforts measure
> different things, and only one of them measures what this tool does.

## The one thing that disqualifies a model

**The model must support tool calling.** A model that cannot emit tool calls will
loop uselessly and produce nothing. This is not a quality question, it is a
hard gate.

On LM Studio, check before spending a run:

```bash
curl -s http://localhost:1234/api/v0/models \
  | jq -r '.data[] | select(.capabilities // [] | index("tool_use")) | .id'
```

On one installation surveyed, **16 of 27 installed models** advertised `tool_use`.
The eleven that did not included several well-regarded coding models whose chat
templates predate tool calling — notably older Codestral and DeepSeek-Coder-V2-Lite
builds. Being good at code does not imply being able to call tools.

For endpoints without a capability API (Ollama, vLLM, llama.cpp server), the
practical test is one turn: if the first response contains neither a tool call nor
usable content, the model cannot do this job.

## Hardware profiles

Sizes are the model weights only. **Context costs extra.** A large KV cache can add
many gigabytes on top of the weights, so leave headroom — a model that just barely
fits at its default context will fail when you raise the window.

| Usable memory for models | Cheap tier (sweep) | Strong tier (escalate) |
|---|---|---|
| **~8 GB** — small laptop, 8 GB consumer GPU | `gemma-4-e2b` (~4.4 GB) | none — run the cheap tier only |
| **~12–16 GB** | `gemma-4-e2b` | `gpt-oss-20b` (~11.3 GB) |
| **~24–32 GB** | `gemma-4-e2b` | `gemma-4-26b-a4b` (~16.8 GB) |
| **~48 GB** — e.g. 64 GB Apple Silicon | `gemma-4-e2b` | 32B-class thinking models (~32 GB, tight) |
| **80 GB+** — high-memory host | `gemma-4-e2b` | `qwen3-coder-next` (~48 GB), `gpt-oss-120b` (~59 GB) |

`gemma-4-e2b` appears in every row deliberately: it is small enough to fit anywhere,
supports tool calling, and was the stronger of the two models actually measured on
agentic work relative to its size.

**Check capacity before loading, not by crashing.** LM Studio answers "will this
fit?" in about a second without loading anything or evicting a resident model:

```bash
lms load "<model>" --estimate-only -y
```

## What was actually measured

### Agentic tool loops — the relevant measurement, and a tiny sample

Two models, one task: enumerate every route in a 494-line TypeScript file that
validates a request body, citing line numbers. Ground truth from `grep`: six routes.

| Model | Params | Recall | Line citations | Fabricated | Wall | Terminated by |
|---|---|---|---|---|---|---|
| `qwen3-coder-next` | 80B (4-bit) | 6/6 | exact | none | 34.2s | tool call |
| `gemma-4-e2b` | 4.6B | 5/6 | exact | none | 13.4s | prose, no tool call |

Two findings worth more than the scores:

1. **A 4.6B model produced exact line citations and fabricated none** — at 40% of the
   80B model's wall time. Small models are more useful here than their size suggests.
2. **The small model ended its turn in prose rather than calling a terminator tool.**
   A harness that requires a `finish` tool call records that correct answer as a
   failure. Treat "assistant message with no tool calls" as completion.

**This is a two-model, one-task sample.** It is enough to show the cheap tier is
viable and not enough to rank models. Contribute measurements if you have them.

### Six models, read and write loops (2026-08-06)

A later bench ran six tool-capable models over two tasks against a planted
fixture: a read task (cite every validating route; ground truth 3 lines) and a
**write task** (fix a one-line typo via `edit_file` in a worktree, gated by a
`test_cmd`). Full table and method in the repo's `docs/bench/2026-08-06-lan-host.md`.

| Model | Read recall | Write gate | Read wall | Write wall |
|---|---|---|---|---|
| `gemma-4-e2b` (4.6B) | 3/3 exact | PASS | 7.2s | 3.0s |
| `gemma-4-e4b` | 3/3 exact | PASS | 15.3s | 7.3s |
| `nemotron-3-nano-4b` | 3/3 exact | PASS¹ | 21.3s | 17.3s |
| `gpt-oss-20b` | 3/3 exact | PASS | 10.4s | 4.2s |
| `qwen3.6-27b` | 3/3 exact | PASS | 44.2s | 34.1s |
| `qwen3-coder-next` | 3/3 exact | PASS | 55.0s | 6.0s |

¹ After one transient engine-side `HTTP 400` retried clean.

What it changes about model picks:

- **Every model held the write loop** — read → exact-match edit → gate pass,
  caller's tree untouched. Single-file mechanical edits are cheap-tier work.
- **Dense mid-size models are the wrong shape on Apple Silicon.** The dense
  27B took 4–6× the wall of its MoE peers at zero accuracy gain on these
  tasks. `gpt-oss-20b` (MXFP4 MoE) was the best big-model value: fastest
  non-gemma, lowest token burn.
- **Big-model wall time is generation-bound, not load-bound.** Warm reruns
  matched cold ones within ~20% — budget for output length, not JIT load.

### Constrained JSON extraction — a larger benchmark that does *not* transfer

A separate effort measured 17 models on schema-constrained JSON extraction
(`response_format: {type: "json_schema", strict: true}`), six fixtures, concurrency 4.

| Model | Score | Items/min |
|---|---|---|
| 32B-class thinking model | 5/6 | 5.1 |
| `gemma-4-26b-a4b` | 5/6 | 3.2 |
| `gemma-4-31b-qat` | 5/6 | 1.5 |
| `gemma-4-e2b` | 4/6 | **17.6** |
| `gemma-4-e4b` | 4/6 | 7.9 |
| `gpt-oss-20b` | 3/6 | 17.7 |
| 1B-class instruct model | 2/6 | 30.8 |

**Do not read this as a capability ranking for agentic work.** That effort explicitly
did not measure chat, code, long context, tool use, or vision. Several models that
score well there have no `tool_use` support at all and cannot be used by this tool.
It is included because it is real data on throughput and on schema adherence, both of
which matter, and because three of its results contradict the obvious prior:

- **Bigger is not better.** `gemma-4-e4b` did not beat the smaller `gemma-4-e2b` on
  accuracy and was 2.2× slower.
- **Quantization-aware training can be a throughput trap.** A 31B QAT build scored the
  same as a 32B thinking model at 1.5 vs 5.1 items/min — the memory saving cost most
  of the throughput.
- **Accuracy and speed were close to independent.** The fastest model measured was
  also near the bottom on accuracy.

### Concurrency

Measured warm, one loaded model, identical requests:

| Concurrent requests | Throughput (req/min) | vs sequential |
|---|---|---|
| 1 | 24.7 | 1.00× |
| 2 | 41.4 | 1.68× |
| 4 | **48.0** | **1.95× — peak** |
| 8 | 41.0 | 1.66× — degrades |

Requests genuinely overlap but share compute, so throughput saturates near 2× and
peaks around 4-way. At 8 concurrent, per-request latency spread more than doubled —
the extra requests were queueing, not running.

**Concurrency applies within one loaded model.** It says nothing about running
several models at once.

**Cold starts fake enormous speedups.** One early measurement reported an "8.7×
concurrency gain" whose sequential baseline was a cold request including model load.
Warm, the same request was 5× faster. Discard several warm-up requests before timing
anything.

## The two-pass recipe

Run the cheap tier over everything, then re-run only the ambiguous or high-stakes
items on the strong tier. Re-running ~20% of a corpus on a slow accurate model costs
far less than running all of it there.

This is why `subagents` config has named tiers and why `--tier` overrides a profile's
default.

## Sampling parameters

**Wrong sampling parameters produce wrong results that look real.** There is no
universal setting — use the values the model family publishes, per family.

| Family | temperature | top_p | top_k | Basis |
|---|---|---|---|---|
| Qwen3 — thinking | 0.6 | 0.95 | 20 | vendor; greedy explicitly forbidden |
| Qwen3 — non-thinking | 0.7 | 0.8 | 20 | vendor |
| Gemma 3 / 4 — general | 1.0 | 0.95 | 64 | vendor baseline |
| Gemma 4 — factual / extraction | 0.3 | 0.95 | 64 | vendor task guidance (0.1–0.3 factual) |
| Olmo-3-Think | 0.6 | 0.95 | 50 | `generation_config.json` and model card |
| Nemotron — reasoning on | 0.6 | 0.95 | — | model card |
| Nemotron — reasoning off | greedy | — | — | model card |
| Ministral / Mistral | 0.0 | — | — | vendor inference example uses greedy |
| GLM | 0.6 | 0.8–0.95 | — | vendor docs |
| gpt-oss | 1.0 | 0.95 | — | third-party; card specifies only `do_sample: true` |

**"Never use greedy decoding" is family-specific advice, not a rule.** Qwen forbids
it — at `temperature: 0` one Qwen model burned its entire completion budget on
reasoning and returned no content, which was initially recorded as a model defect
rather than a configuration error. Mistral's own inference example uses
`temperature=0.0`. Nemotron wants greedy when reasoning is off and 0.6/0.95 when it
is on, making it a per-request decision.

Look for values in this order: `https://huggingface.co/{model}/raw/main/generation_config.json`,
then the model card README, then vendor docs. Generic web search is the weakest
source and has returned "no published guidance" for models that publish exact values
on their card.

## Operating gotchas

These cost real debugging time. Each one has been hit in practice.

**The loaded context window is usually far below the model's maximum.** A model
advertising a 262,144-token maximum loaded at 32,768 because that was the load-time
setting — and an earlier default of 8,192 is low enough to kill an agentic loop within
a few turns, since every tool result stays pinned in history. Check both numbers:

```bash
curl -s http://localhost:1234/api/v0/models/<model-id> \
  | jq '{max_context_length, loaded_context_length}'
lms load "<model>" --context-length 32768 -y --ttl 1800
```

**`max_tokens` must fit under the loaded context.** Exceeding it returns an engine
error with no `choices` array — which a parser looking only for `choices` will
misread as a model failure rather than a configuration error.

**Budget tokens for reasoning, not for the answer.** On one bounded extraction schema
the answer was p50 157 tokens and p99 262, while reasoning routinely ran
1,000–2,100 tokens and once reached 4,348. A budget sized for the answer starves the
response entirely.

**Verify residency before timing anything.** `lms ls` lists what is on disk; `lms ps`
lists what is actually resident, with its context size and parallelism. Reading
`lms ls` as "22 models ready" is wrong — it means "22 on disk".

**Beware federated installations.** LM Studio instances can serve each other's
models, so `localhost` may transparently answer from another machine. The same model
key can exist on two devices with *different* builds and parameter counts, and a
request may load remotely even when given an unprefixed local path. A "local vs
remote" comparison is only meaningful for a model present on both — otherwise both
sides hit the same host. Confirm with `lms ps` which device answered.

**Check reachability with TCP, not ping.** ICMP is often dropped by firewall policy
while the API port stays open, so `ping` can report total loss for a machine that is
serving normally.

**LM Studio silently serves unknown model ids with whatever is loaded.** A tier
pointing at a nonexistent model id returned clean answers from the resident model —
no error anywhere in the stack. A typo'd model name benchmarks the wrong model.
Until the capability-probe adapter lands, verify the id against
`/api/v0/models` before trusting any measurement.

**Bun's `fetch` does not resolve bare LAN hostnames that `curl` does.** `curl` picks
up the resolver's search domain (`myhost` → `myhost.localdomain`); Bun's fetch
reports "Unable to connect" for the same name. Use an IP or FQDN in `base_url`.

**Persist every raw response before parsing it.** Scoring and parsing bugs are
common, and having the payloads on disk turns a re-run into a re-score. In one
effort, re-validating stored responses against a tightened schema identified 22% of
rows as needing re-extraction and left the rest untouched — without persisted raw
output that is a full re-run.

## Contributing measurements

The agentic-loop table above is two models on one task, which is not enough. If you
run `subagents` against a model on hardware not represented here, the useful report
is: model id and quantization, usable memory, loaded context, the task, ground-truth
recall, whether line citations were exact, whether anything was fabricated, wall
time, and how the model terminated. Fabrication rate and termination style matter as
much as recall. For comparable rows, use the repo's benchmark suite (`subagents bench`):
rows measure harness variants, not model capability — public exercises contaminate
absolute scores, so treat them as inflated and read only the deltas (see
[bench/README.md](../../bench/README.md)).
