# bnt campaign — harness insights log

Append-only. One dated entry per wave/pilot; metrics + anything that changed
an operating rule. Durable findings graduate to SKILL.md / the wiki.
Campaign plan: `~/dev/bnt/docs/plans/2026-08-07-completion-plan.md`.

## 2026-08-07 — pilot (pre-plan calibration)

Target repo: `~/dev/bnt` (SvelteKit + Bun + Drizzle, tab-indented, ~30 source
files). First harness use on a repo it wasn't developed against.

**Runs**

| run | tier/model | result |
|---|---|---|
| digest: auth survey | cheap / nemotron-3-nano-4b | ok · 13 turns · 65s · exact file+line citations · **truncations: 8** |
| write: export 3 validators | cheap / gemma-4-e2b | error · exit 2 · gate `install PASS, tests FAIL` · worktree kept |
| write: same job | strong / qwen3-coder-next | ok · exit 0 · 6 turns · 66.5s · minimal 3-line diff · gate green |

**Findings**

1. **Tab-indented files break cheap-tier `edit_file`.** gemma-4-e2b missed
   exact-match `old_string` 3× on a 208-line tab-indented file, fell back to
   full-file `write_file`, and truncated the tail (lost the final `}`) 3×.
   The syntax ridealong fired on every bad write (`[SYNTAX: Unexpected end of
   file]`) and the model still couldn't recover — capacity, not signal, was
   the limit. Sizing rule adopted: cheap writes only ≲120-line files;
   strong-first above; escalation net always.
2. **Envelope misdiagnosis (plugin bug):** after 10 turns of successful tool
   calls, the model emitted an empty turn and the summary said "likely cannot
   call tools". Wrong when prior turns called tools; should read "stopped
   responding after N failed attempts". Backlog #1.
3. **Worktree bootstrap pattern proven:** `checks: [install → tests]` with
   `bun install --frozen-lockfile` as stage 1 works; ~2s on warm Bun cache,
   both runs, including native `bcrypt`.
4. **Read caps bite on real repos:** 8 truncations in one digest vs 0 on
   harness-native fixtures. `truncations>0` = the delegate worked partially
   blind; treat digest claims accordingly. Backlog #2 (per-profile caps).
5. **LM Studio types multimodal models as `vlm`:** filtering `/api/v0/models`
   on `type=="llm"` made gemma-4-e2b/e4b and qwen3.6-27b look deleted and
   caused a spurious re-tiering. Any preflight must include `llm` **and**
   `vlm`. (Also: evox2 gained deepseek-v4-flash, glm-4.7-flash, gpt-oss-120b,
   laguna-s-2.1, qwen3.6-35b-a3b — unbenched candidates.) SSH works as
   `hammond@evox2.local` (not the Mac-side username); the bnt project's
   origin workspace lives there under `~/.openclaw/workspace/`.
6. **The TDD contract transfers to foreign repos unchanged:** RED authored +
   run red + committed by orchestrator; per-run gate; tamper check
   (`files_changed` excluded the spec test); full diff read before accept.
   The strong-tier diff was exactly the 3 `export` keywords requested.
7. **Contract > capability.** All three runs produced honest envelopes; every
   failure was the model's, correctly surfaced with evidence (kept worktree,
   per-stage verdicts, syntax notes). The delegation economy only needs the
   envelope to be truthful — it was.

## 2026-08-07 — calibration batch 1 (5 jobs, Phase 0)

First real `batch` run against bnt: 2 cheap writes, 1 cheap digest, 2 mid
digests, `--escalate-tier strong`. Result: `partial` — 2 ok, 3 dead, 138.7s
wall, 68.7k local tokens.

**Findings**

8. **LM Studio 500s instantly under concurrent multi-model load.** With the
   provider default `max_in_flight: 2` and jobs spanning three model ids,
   requests that arrived while another model was JIT-loading got immediate
   HTTP 500 (0–0.2s, zero tokens). 3 of 5 jobs died this way. Fix applied:
   `max_in_flight: 1` on the evox2 provider — LM Studio on one box is a
   one-model-at-a-time server; treat that as a provider property, not a
   batch tuning knob. (Consider documenting in the wiki: `kind: lmstudio`
   providers should default to 1.)
9. **Escalation burns itself on infra errors (plugin gap).** Escalate-on-error
   assumes model failure; an HTTP 500 is provider failure. Two jobs lost BOTH
   attempts to the same transient 500 — the escalation retried instantly into
   the same contention and no model ever saw the task. Backlog: distinguish
   transport/HTTP-5xx errors from model errors; retry same tier with backoff
   before spending the escalation.
10. **Honest gates catch partial compliance.** readme-tests (cheap,
    gemma-4-e2b) did the section rewrite but missed one stale count elsewhere
    in the file; the `! grep` stage failed the gate exactly as designed.
    Grep-negation checks are cheap and effective acceptance tests for
    doc-editing jobs.
11. **Mid tier (gemma-4-e4b) handled a cross-referencing digest** (status
    audit across 4 sources, 8 turns, 54s, line-cited) with zero truncations.
    Digest task design matters more than tier: pointed questions with named
    files beat open surveys.

## 2026-08-07 — calibration retry (3 jobs, serialized)

`max_in_flight: 1` on the provider: all 3 jobs ok, zero 500s, 165s wall.
Serialization confirmed as the LM Studio fix.

12. **Gutter echo: cheap models copy the read-tool's line-number gutter into
    full-file rewrites.** gemma-4-e2b "passed" the README job with every line
    prefixed by 4–5 spaces of the read format's indentation — content intact,
    markdown destroyed (indent = code block), and the unanchored grep gate
    passed. Two rules adopted: (a) doc-rewrite gates must anchor
    (`grep -q '^# Title'`) so format damage fails the gate; (b) instruct
    "edit only the lines that need changing — do not rewrite the whole file".
    With rule (b), strong tier produced a clean 31+/16− targeted diff, 44/44
    headings intact. Possible plugin guard: flag a write_file whose lines
    share uniform leading whitespace absent from the previous version.
13. **Acceptance is the orchestrator's job, not the gate's.** Both bad
    outcomes today (README gutter echo, stale count left elsewhere in file)
    were caught only because the diff was actually read before applying.
    The gate narrows the funnel; the diff read is the decision.

Calibration scorecard (Phase 0): 8 delegate write attempts → 5 accepted
diffs, 3 rejected (all caught before apply); 3 digests delivered planning
inputs. Every acceptance decision was made from envelopes + diffs alone —
no transcript reads needed except for digest content extraction.

## 2026-08-07 — Phase 0 close-out (E2E verdict, lazy-db wave)

14. **Negative results are deliverables.** The Sonnet E2E agent (77 tool
    calls) reproduced CI exactly, ruled out five hypotheses by reading real
    diffs, refused to commit a speculative fix, and named its residual risk
    (macOS vs Linux). The clean Linux CI run on PR #7 then confirmed master's
    red was transient runner flake. Zero code changed for the "bug" — the
    discipline saved a junk fix.
15. **Gates can't see type fidelity or `this`-binding.** The lazy-db delegate
    passed every check while typing the export as `any`/`{}` and returning
    unbound methods through its Proxy (drizzle builders rely on `this`;
    mocks in the suite bypass the real paths, so tests stayed green).
    Orchestrator diff-review caught both; amended inline rather than
    re-dispatching. Rule: infra/refactor diffs get reviewed specifically for
    type degradation and binding, not just behavior. bnt needs a real
    `typecheck`/`svelte-check` stage (added to Phase 0 list).
16. **Coverage gates couple to import topology.** Making db init lazy
    silently un-covered 69 lines (init path + schema relation callbacks that
    only run when `drizzle()` constructs) — local suite green, but the 98%
    CI gate would have failed. One in-process test touching the proxy
    restored 98.32%. Lesson: any refactor that moves work out of import time
    changes coverage; measure locally before pushing.
17. **TDD contract scales to build-infra bugs.** vite-build crash → RED spec
    (subprocess import without env) → strong-tier delegate fix (24.5s,
    4 turns) → orchestrator amendments → build verified end-to-end. The
    same loop that fixed a missing `export` fixed a SvelteKit postbuild
    crash; only the spec authorship got harder.

## 2026-08-07 — Phase 1 shell wave (first feature delegation)

First new-feature module by a delegate: `src/lib/server/game/shell.ts`
(147 lines, new file) against a 5-test RED spec. Strong tier, 15 turns,
73.7s; 4/5 tests green on delivery, 1-line orchestrator amendment closed the
fifth. UI half (SvelteKit page + HUD) stayed orchestrator-side per the
delegate-territory rule, browser-verified against a seeded local Postgres;
14/14 E2E after.

18. **Dependency injection beats mock.module for delegate-facing contracts.**
    bun's `mock.module` is process-global per specifier — a second test file
    mocking the db would collide with the existing suite's mock
    (last-wins, file-order dependent). Passing the db handle as a parameter
    sidestepped that entirely AND exposed finding 19. Adopt for all new
    server modules: db is an argument, not an import.
19. **Delegates satisfy the letter of the WHERE, not the spirit of the
    filter.** The spec demanded defensive in-code filtering (own ship,
    destroyed ships); the delegate put half of it in the drizzle `ne()`
    WHERE clause — which the DI stub deliberately ignores, so the gate
    caught it (4/5). The failure mode generalizes: models push invariants
    into layers the test can't observe. Write specs whose stubs ignore
    query arguments, and say explicitly which layer must enforce what.
20. **Feature waves have a natural seam: data module (delegate) / page
    wiring + UI + visual verify (orchestrator).** The seam held: zero
    rework at the boundary, and the RED spec doubled as the interface
    contract the page code was written against.
21. **Learn the target repo's own gates before declaring green.** bnt's
    `check-e2e-testids.ts` hard-fails CI when any Svelte `data-testid`
    lacks E2E coverage — the orchestrator ran it locally but piped it
    through `tail`, masking exit 1, and shipped a PR that CI rejected.
    Two rules: enumerate the target repo's CI steps into the wave's local
    verification checklist verbatim, and never read a gate's verdict
    through a pipe (`cmd; echo $?`, not `cmd | tail`). Cost: one CI
    round-trip. (Same failure family as LM Studio's silent model
    substitution: the tool reported what the pipeline showed it, not what
    happened.)
