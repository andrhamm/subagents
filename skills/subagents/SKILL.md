---
name: subagents
description: Use when delegating a scoped investigation or a worktree-confined edit to a local or self-hosted model instead of doing it yourself — bulk triage across many files, digesting large logs or diffs, enumerating patterns repo-wide, delegated small edits with a test gate. Triggers on delegate, subagent, local model, LM Studio, Ollama, offload, cheap pass, bulk audit, save tokens, save context. Load before invoking the subagents CLI.
user-invocable: true
---

# subagents

Run an agentic subagent against any OpenAI-compatible endpoint. The
delegate runs its own tool-calling loop — reading files, globbing, grepping,
and editing files — and returns a small JSON envelope. Its transcript stays on
disk; read it only when something needs checking.

**What ships today:** the agentic loop above, config-driven providers and
tiers, and these seven tools:

- `read_file` — read a text file with line numbers, paged by offset/limit.
- `glob` — find files by shell glob pattern.
- `grep` — search file contents by regex, returning `path:lineno:text`.
- `list_dir` — list files under a directory, recursively.
- `edit_file` — replace an exact substring in a file already read.
- `write_file` — create a new file or overwrite one already read.
- `run_checks` — run the profile's configured checks in order — no arguments.

**What doesn't:** bash, MCP tools, and the benchmark harness are all planned
but not present — do not tell a delegate to run a command, and don't
configure a profile expecting one to.

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
  enumeration, anything you'd otherwise read thousands of lines to answer.
- **Don't delegate**: single small files, anything needing judgement about
  product intent, or anything where you cannot check the result cheaply —
  writing is delegable via a write profile (see below), but only when you
  can read the diff and, ideally, gate it with `test_cmd`. Applying a diff
  you haven't read is the failure mode, not delegating the edit itself.
- **Latency is worse, not better.** A delegated triage took 107s where you'd
  take under a minute. The win is context and cost, never speed.

## Invocation

```bash
subagents run --profile <name> --task "<task>" --root <repo>
```

Real options (`subagents run --help` prints the same list):

- `--profile <name>` — required. Selects a profile from config, which sets the
  tool allowlist and a default tier. A profile also carries `worktree`
  (defaults to true when the profile has a write tool) and `test_cmd` — see
  [Write profiles](#write-profiles) below.
- `--task <text>` — required. What the delegate should do.
- `--root <dir>` — repo root the delegate is confined to (default: cwd).
- `--tier <name>` — override the profile's default tier.
- `--config <path>` — config file (default: `./subagents.yaml`, then
  `~/.config/subagents/config.yaml`).
- `--transcript <path>` — where the full message transcript is written
  (default: a temp file). Always a single pretty-printed JSON object, not a
  `.jsonl` stream.
- `--deadline-secs <n>` — wall-clock budget (see below).
- `--verbose` — per-turn progress to stderr.

## Write profiles

A profile with `edit_file`/`write_file` runs in a **git worktree detached at
HEAD**. Three consequences you must plan around:

- **The delegate sees your last commit, not your working tree.** Commit or
  stash before delegating an edit, or the delegate edits stale code.
- **The edit lands in the worktree**, whose path the envelope reports as
  `worktree`. Inspect `git -C <worktree> diff HEAD` (everything is staged),
  then apply what you accept — e.g. `git -C <worktree> diff HEAD | git apply`.
  Nothing touches your tree until you do this.
- **Budget for the test gate.** `test_cmd` (sugar for a single `tests` stage)
  or an ordered `checks:` list runs after the loop, inside the worktree,
  stopping at the first failing stage. `test_timeout_ms` (default 120s) is a
  **per-stage** budget, not a total — your shell timeout must cover
  `--deadline-secs` *plus* every configured stage at that ceiling.

Exit 0 now means the loop completed **and** the gate (if configured) passed.
A failed gate exits 2 with `test.passed: false` — the worktree is kept, so a
failed-but-close diff is still yours to salvage or discard.

## Exit codes

- **`0`** — completed: status "ok" and the test gate (if configured) passed.
- **`2`** — ran, but status is not "ok" or the test gate failed — an envelope is
  still on stdout; read it before treating this as failure.
- **`1`** — never started — nothing on stdout, the error is on stderr.

## Reading the envelope

```json
{ "status": "ok", "summary": "...", "turns": 4, "wall_secs": 12.0,
  "files_changed": ["src/rate-limit.ts"], "diffstat": "1 file changed, 1 insertion(+), 1 deletion(-)", "test": {"ran": true, "passed": true, "cmd": "bun test"},
  "checks": [{"name": "tests", "passed": true, "timedOut": false}], "worktree": "/tmp/subagents-wt-…",
  "context": {"peak_prompt_tokens": 21628, "limit": null, "pressure": null},
  "truncations": 0, "local_tokens": 21628, "transcript": "..." }
```

`checks` is the per-stage detail (one entry per configured stage, in order,
stopping at the first failure); `test` stays the overall verdict regardless
of how many stages ran.

`status` is one of `ok`, `max_turns`, `budget`, `deadline`, `error` — there is
no `"stopped"`. Write runs include `files_changed`, `diffstat`, `test`,
`checks`, and `worktree`; read-only runs don't. `checks` always has at least
one entry once any gate ran — plain `test_cmd` desugars to a single `tests`
stage, so it populates both fields, not just `test`. `tools_omitted` doesn't
exist yet (the MCP client hasn't landed). Check these before trusting
`summary`:

- **`truncations` > 0** — the delegate was working blind on part of its input.
  Its coverage claims are unsafe. Re-run narrower, or escalate a tier.
- **`status: "error"`** — read `detail`. One real cause: the model returned no
  tool calls and no content on some turn — a capability problem (the model
  can't call tools, or chose not to), not a task failure.
- **`context.limit` / `context.pressure`** — currently always `null`. The
  context-limit probe (an LM Studio adapter) hasn't landed, so pressure can't
  be computed yet. A `null` here means "unknown," not "no pressure."
- **`status: "deadline"` / `"max_turns"` / `"budget"`** — a partial result, not
  a failure. `summary` falls back to `detail` when the run stopped before
  producing prose (e.g. mid-tool-call), so it's never blank on a real stop.
- **`test.passed: false`** — the delegate's diff breaks a configured check.
  Find which one in the envelope's `checks` array (`passed: false` or
  `timedOut: true`), then read that stage's section in the transcript's
  `test_output` — one `=== name: verdict ===` block per stage, in order — to
  see its output before deciding whether to salvage or discard. The worktree
  is kept either way.

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
- **Never apply a diff you haven't read.** The envelope's `files_changed` says
  where the delegate edited, not that the edits are right. Read the worktree
  diff; the test gate narrows the risk but a passing gate is not review.
- **A diff that touches your spec test proved nothing.** Check
  `files_changed` before reading anything else; if the test you authored is
  in it, reject the run.

## Tiering

Mirror the cheap-sweep-then-escalate pattern:

1. Run the **cheap** tier over everything. It is several times faster and, on
   enumeration tasks, close to the strong tier in recall.
2. Re-run only the ambiguous or high-stakes items on the **strong** tier via
   `--tier <name>`.

Measured on one enumeration task: 4.6B scored 5/6 in 13.4s; 80B scored 6/6 in
34.2s. A later six-model bench (4.6B–80B) scored 3/3 with exact citations on
every model, and **every model held a single-file write loop** with the test
gate passing — cheap-first applies to write jobs too, with `--escalate-tier`
as the safety net. Re-running 20% of a corpus on the strong model costs far
less than running all of it there.

## TDD delegation: the test is the task

For behavior changes, don't describe the change — hand over a failing test:

1. **You** write the spec test and run it RED yourself; commit it (the
   delegate sees your last commit — the RED state must be in it).
2. Dispatch with the test as the gate:
   `--task "tests/retry.test.ts::accepts HTTP-dates fails; make it pass" `
   plus a per-job `test_cmd` (or `checks`) running exactly that test.
3. The delegate (give it `run_checks`) watches itself go green in-loop;
   the harness gate re-verifies after the loop.
4. Accept mechanically: exit 0, AND `files_changed` does **not** include
   your spec test (a delegate that edits the spec passed nothing), AND you
   read the diff.

Specifying behavior is judgment — keep it. Making a red test green is
mechanical — delegate it, cheap tier first.

## Batch: many jobs, one envelope

Thirty envelopes dispatched one at a time cost ~25k tokens across thirty
turns; one batch returns a single rollup. Delegate in batch whenever you have
more than a handful of jobs:

```bash
subagents batch --jobs jobs.yaml --escalate-tier strong \
  --deadline-secs 280 --progress /tmp/batch-progress.json
```

- Jobs group by (provider, model) — each model loads exactly once. Order in
  the file doesn't matter; grouping is the scheduler's job, not yours.
- `--escalate-tier` runs the sweep-then-escalate recipe inside one call:
  jobs that failed, stopped early, or worked blind (`truncations > 0`)
  re-run once on the named tier, and each job's report carries both attempts.
- The batch deadline stops *starting* jobs. `not_run` in the rollup names
  what never started — those jobs need a re-run, not an apology.
- For batches that outlive your shell timeout, run in the background and
  poll `--progress`: `{total, done, running, pending, not_run}`, one JSON line.
- Read `concurrency` before tuning: a widening p50→max latency spread with
  flat throughput is queueing, not parallelism — lower `max_in_flight`.
  Rising `queue_wait` says the same. And a ceiling measured on a shared host
  goes stale the moment someone else loads a model on it.

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

## Model capability

Not every model on an OpenAI-compatible endpoint can call tools, and a model
that cannot will loop uselessly. The loop's own capability gate catches the
worst case: a turn with no tool calls and no content returns `status: "error"`
naming the model, rather than reporting empty success. It's still worth
confirming your model advertises tool-use before spending a run — a model that
occasionally answers in prose instead of calling a tool will complete as
`status: "ok"` with a real but possibly incomplete answer, which the gate
above can't distinguish from a deliberate stop.
