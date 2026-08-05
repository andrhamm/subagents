---
name: subagents
description: Use when delegating a scoped coding task to a local or self-hosted model instead of doing it yourself — bulk triage across many files, digesting large logs or diffs, enumerating patterns repo-wide, or mechanical multi-file edits. Triggers on delegate, subagent, local model, LM Studio, Ollama, offload, cheap pass, bulk audit, save tokens, save context. Load before invoking the subagents CLI.
user-invocable: true
---

# subagents

Run an agentic subagent on any OpenAI-compatible endpoint. The delegate does its
own tool-calling loop — reading files, grepping, optionally editing — and returns
a small JSON envelope. Its transcript stays on disk and you read it only when
something failed.

## When delegation actually pays

Delegation is not free. The envelope costs you roughly 150–850 tokens depending
on how much the delegate says. So the decision is arithmetic, not taste:

**Delegate when the input the delegate consumes on your behalf is large.**

Measured example: a repo-wide triage burned **165,362 tokens on the delegate** and
returned **~850 tokens** to the orchestrator — about 195:1. Reading those files
directly would have pinned 40k+ tokens into context permanently.

Counter-example: a single 17-line file with a known bug. Reading and fixing it
yourself costs ~600 tokens. The envelope alone costs ~150. Delegating saves
almost nothing and adds latency plus a trust problem.

Rules of thumb:

- **Delegate**: work spanning many files, large logs or diffs, repo-wide
  enumeration, repetitive mechanical edits, anything you'd otherwise read
  thousands of lines to answer.
- **Don't delegate**: single small files, anything needing judgement about
  product intent, anything where you cannot check the result cheaply.
- **Latency is worse, not better.** A delegated triage took 107s where you'd
  take under a minute. The win is context and cost, never speed.

## Invocation

```bash
subagents run --profile digest --task "<task>" --root <repo>
subagents run --profile edit --task "<task>" --root <repo> --tier strong
```

Profiles come from config and set the tool allowlist, tier, worktree behaviour,
and test command. Prefer a named profile over ad-hoc tool flags.

## Reading the envelope

```json
{ "status": "ok", "summary": "...", "turns": 4, "wall_secs": 12.0,
  "files_changed": [], "test": {"ran": false},
  "context": {"peak_prompt_tokens": 21628, "limit": 32768, "pressure": 0.66},
  "truncations": 0, "tools_omitted": [], "transcript": "..." }
```

Check these before trusting `summary`:

- **`truncations` > 0** — the delegate was working blind on part of its input. Its
  coverage claims are unsafe. Re-run narrower, or escalate a tier.
- **`context.pressure` near 1.0** — it ran out of room; later findings may be
  missing even with `status: ok`.
- **`tools_omitted`** — a configured tool server was unreachable, so the delegate
  worked without it.
- **`status: stopped`** — it ended in prose rather than a tool call. This is
  normal for small models and often still a *correct answer*. Read `summary`
  before treating it as failure.

## Trust rules

The delegate is reliable about specifics and unreliable about scope.

- **Never accept a universal or absence claim.** "All routes validate their input"
  or "no other callers exist" must be checked with `grep` or a test. In testing, a
  model asserted exactly that while having seen only half the routes.
- **Do accept specific citations, then spot-check cheaply.** With line-numbered
  reads, both an 80B and a 4.6B model produced exact line numbers and fabricated
  none. Verify two or three, not all.
- **Never trust a count it states.** One model wrote "Found 7 routes" above a list
  of 6. Count the list yourself.
- **Small models mangle incidentals.** A 4.6B model got every line number right
  while garbling route path formatting. Trust the anchor, re-derive the detail.

## Tiering

Mirror the cheap-sweep-then-escalate pattern:

1. Run the **cheap** tier over everything. It is several times faster and, on
   enumeration tasks, close to the strong tier in recall.
2. Re-run only the ambiguous or high-stakes items on the **strong** tier.

Measured on one enumeration task: 4.6B scored 5/6 in 13.4s; 80B scored 6/6 in
34.2s. Re-running 20% of a corpus on the strong model costs far less than running
all of it there.

## Always pass a deadline

You are invoking this through a shell tool with a hard wall-clock limit. If the CLI is
killed at that limit you get **truncated output and no envelope** — no summary, no
transcript path, no way to tell whether any work happened.

So tell the harness your budget, set below your own timeout:

```bash
# shell tool timeout 300s → give the harness 280s
subagents run --profile digest --task "…" --root . --deadline-secs 280
```

The harness then tracks its worst observed turn duration and stops before a turn that
would overrun, returning `status: "deadline"` with the partial findings and the
transcript path. A partial result you know is partial is useful; being killed is not.

When you get `status: "deadline"`, the remedy depends on why:

- **Turns were slow but progressing** → re-run with a longer shell timeout and a
  correspondingly larger `--deadline-secs`.
- **The task was too broad** → narrow it. Delegating "audit every route in the repo" is
  worse than delegating one directory at a time.
- **It is genuinely a long job** → run it in the background rather than blocking, and
  poll the progress file. Anything beyond the 600s shell maximum must work this way.

## Tuning concurrency

The harness runs at the `max_in_flight` its config declares and reports what actually
happened. You decide whether to change it. Default is a deliberately conservative 2.

```json
"concurrency": {
  "configured": 4, "achieved_throughput_per_min": 48.0,
  "latency_p50_secs": 5.6, "latency_max_secs": 11.7,
  "queue_wait_secs": 0.2, "timeouts": 0, "errors": 0
}
```

Read it like this:

- **Throughput rose roughly with the setting, spread stayed tight, no timeouts** →
  room to go higher. Raise it one step.
- **Throughput flat or lower while `latency_max` pulls away from `latency_p50`** →
  you are queueing, not parallelising. Lower it. On one measured host, 8-way produced
  *less* throughput than 4-way while per-request latency spread more than doubled.
- **`queue_wait_secs` climbing** → same conclusion, more directly.
- **Any `timeouts` or `errors` above zero** → lower it now and re-run. A saturated
  host fails requests rather than slowing them.

Expect diminishing returns fast. On the one host measured in detail, 2-way captured
1.68× and 4-way peaked at 1.95× — most of the benefit arrives at 2.

Two things that will mislead you:

- **A ceiling goes stale.** Shared hosts have other users; a value that was right an
  hour ago may not be now. Re-read the evidence rather than trusting a past setting.
- **Cold starts fake enormous gains.** If the first request in a run included a model
  load, its baseline is worthless — an early measurement elsewhere reported an "8.7×
  concurrency gain" that was entirely model-load time. Discard the first run after a
  model change before drawing any conclusion.

Concurrency applies **within one loaded model**. It says nothing about running several
models at once.

## Write tasks

Writes carry real risk — the delegate has no permission system of its own.

- Keep `worktree: true` on any write profile. The delegate edits an isolated tree;
  you inspect a diff.
- Always configure a `test_cmd`. A failing gate reverts and reports.
- Review `diffstat` and `files_changed`; read the transcript if either surprises
  you.
- Give write tasks pre-scoped file lists. "Go find and fix it" is where delegation
  fails; "in these three files, do this" is where it works.

## Model capability

Not every model on an OpenAI-compatible endpoint can call tools, and a model that
cannot will loop uselessly. On LM Studio, `subagents models` reports the
`tool_use` capability and context limit per model — check before spending a run.
Elsewhere, a first turn returning neither tool calls nor usable content means a
capability problem, not a task failure.
