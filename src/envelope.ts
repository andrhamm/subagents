import type { LoopResult } from "./loop";

// The envelope's small size is the entire reason it exists — a measured run
// burned 165,362 delegate tokens and returned ~850 to the caller. But 600
// was too small once measured against real answers: the fixed fields eat
// ~200 chars, and a 20-item citation list came back with 6 items and a
// truncation marker, sending the caller to the transcript — the exact cost
// the envelope exists to avoid. 1200 (~300 tokens) holds the full list and
// every write field. `summary` and `detail` remain the only fields whose
// length the delegate controls, so they are still the only ones shrunk.
export const MAX_ENVELOPE_CHARS = 1200;
export const MAX_FILES_CHANGED = 10;

export interface EnvelopeTest {
  ran: boolean;
  passed: boolean;
  cmd: string;
}

export interface WriteOutcome {
  /** Root-relative changed paths, from git. Entry-capped at MAX_FILES_CHANGED in the envelope. */
  files: string[];
  /** git --shortstat line; may carry an inspection-failure notice instead. */
  diffstat: string;
  /** The kept worktree's path — the diff lives there. */
  worktree: string;
  test?: EnvelopeTest;
}

export interface Envelope {
  status: string;
  summary: string;
  detail?: string;
  turns: number;
  wall_secs: number;
  context: {
    peak_prompt_tokens: number;
    limit: number | null;
    pressure: number | null;
  };
  truncations: number;
  local_tokens: number;
  transcript: string;
  files_changed?: string[];
  diffstat?: string;
  test?: EnvelopeTest;
  worktree?: string;
}

export interface EnvelopeInputs {
  wallSecs: number;
  transcript: string;
  contextLimit: number | null;
  writes?: WriteOutcome;
}

const round = (n: number, places: number): number => {
  const f = 10 ** places;
  return Math.round(n * f) / f;
};

const TRUNCATION_MARKER = "...[truncated, see transcript]";

const serializedLength = (e: Envelope): number => JSON.stringify(e).length;

/**
 * Shrink `envelope[field]` just enough to bring the whole serialized
 * envelope back under `MAX_ENVELOPE_CHARS`, then mark the cut so a truncated
 * field never reads as a complete one — the transcript still has the rest.
 *
 * Two things a closed-form byte estimate got wrong, both fixed by finding
 * the cut this way instead of computing it:
 *
 * - `String.prototype.slice` cuts on UTF-16 code units. A cut landing
 *   inside a surrogate pair (an emoji, say) leaves a lone surrogate, which
 *   `JSON.stringify` re-encodes as a 6-character `\udXXX` escape — so a
 *   "removed" character can make the encoded output *larger*, not smaller.
 *   Working over `Array.from(text)` instead of the raw string means every
 *   candidate prefix ends on a whole Unicode code point; a pair can never
 *   be split.
 * - How many bytes a cut actually saves depends on how many of the removed
 *   characters needed JSON escaping (`"`, `\`, control characters). A fixed
 *   "assume the worst case" formula either overshoots on ordinary text
 *   (discarding far more than necessary) or, as above, undershoots on a
 *   pathological one. Binary-searching the real serialized length at each
 *   step is correct either way, because it never estimates — it measures.
 *
 * Bounded by construction: each step halves the search range, so this is
 * at most ~log2(length) `JSON.stringify` calls on a small object — cheap,
 * and it only runs at all once the envelope is already over budget.
 */
function shrinkField(envelope: Envelope, field: "summary" | "detail"): void {
  const text = field === "summary" ? envelope.summary : envelope.detail;
  if (!text || serializedLength(envelope) < MAX_ENVELOPE_CHARS) return;

  const set = (value: string): void => {
    if (field === "summary") envelope.summary = value;
    else envelope.detail = value;
  };

  const points = Array.from(text);
  set(TRUNCATION_MARKER);
  // Even the marker alone doesn't fit — leave it; the caller-side backstop
  // in buildEnvelope has the last word.
  if (serializedLength(envelope) >= MAX_ENVELOPE_CHARS) return;

  // Largest prefix (in code points) for which `prefix + marker` still fits.
  // `fits` is monotonic non-increasing in the prefix length, so a standard
  // rightmost-true binary search applies; `lo = 0` (marker alone) is
  // already known to fit, from the check just above.
  let lo = 0;
  let hi = points.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    set(points.slice(0, mid).join("") + TRUNCATION_MARKER);
    if (serializedLength(envelope) < MAX_ENVELOPE_CHARS) lo = mid;
    else hi = mid - 1;
  }
  set(points.slice(0, lo).join("") + TRUNCATION_MARKER);
}

export function buildEnvelope(r: LoopResult, o: EnvelopeInputs): Envelope {
  // Sibling of local_tokens's fix below: some proxies report usage counts
  // as strings, and a bare `?? 0` only guards `null`/`undefined`, not a
  // non-numeric string. `Math.max` happens to coerce a numeric string like
  // "500" correctly, which hid this for the one shape already under test —
  // but a genuinely non-numeric value (e.g. a proxy's placeholder string)
  // makes `Number(...)` NaN and `Math.max` propagates it, serializing as
  // `null` in a field typed `number`. Coerce the same way local_tokens does.
  const prompts = r.usage.map((u) => Number(u.prompt_tokens) || 0);
  const peak = prompts.length ? Math.max(...prompts) : 0;

  // Most delegates emit `content: null` alongside tool_calls, so on a real
  // deadline/max_turns stop `r.summary` is usually "" — lastText() in the
  // loop had nothing to return. Falling back to `r.detail` means the caller
  // always gets something in the one field a naive consumer reads, instead
  // of the blank field a partial result exists to avoid. `status` already
  // tells a genuine answer apart from an early stop, so the fallback does
  // not need to fake that distinction itself. Only emit `detail` separately
  // when it says something `summary` doesn't — otherwise it just repeats the
  // string the envelope exists to keep small.
  const summary = r.summary || r.detail;

  const envelope: Envelope = {
    status: r.status,
    summary,
    ...(r.detail && r.summary ? { detail: r.detail } : {}),
    turns: r.turns,
    wall_secs: round(o.wallSecs, 1),
    context: {
      peak_prompt_tokens: peak,
      limit: o.contextLimit,
      pressure: o.contextLimit ? round(peak / o.contextLimit, 2) : null,
    },
    truncations: r.truncations,
    // Some proxies report usage counts as strings rather than numbers.
    // `Number(...) || 0` normalizes either shape to a real number before
    // summing — a raw `+` would silently string-concatenate instead of add.
    local_tokens: r.usage.reduce(
      (sum, u) => sum + (Number(u.prompt_tokens) || 0) + (Number(u.completion_tokens) || 0), 0),
    transcript: o.transcript,
  };

  if (o.writes) {
    const { files } = o.writes;
    // Entry-capped with an explicit remainder — the never-truncate-silently
    // rule applies to the envelope itself. Pathological single-path lengths
    // are the delegate's doing and fall to the final backstop below.
    envelope.files_changed = files.length > MAX_FILES_CHANGED
      ? [...files.slice(0, MAX_FILES_CHANGED), `…+${files.length - MAX_FILES_CHANGED} more`]
      : files;
    envelope.diffstat = o.writes.diffstat;
    envelope.worktree = o.writes.worktree;
    if (o.writes.test) envelope.test = o.writes.test;
  }

  // Detail is supplementary — give it up first. Only reach into summary, the
  // field a naive caller reads, once detail alone can't make room.
  shrinkField(envelope, "detail");
  shrinkField(envelope, "summary");

  // Belt and braces: shrinkField's binary search is bounded and always
  // finds the true largest fitting prefix, so this should never fire. It
  // stays because this is the one invariant the whole component rests on,
  // and a closed-form version of this exact guarantee was wrong once
  // already. If even both fields at their smallest (marker-only) still
  // don't fit — the non-text fields alone are the problem, e.g. an unusually
  // long transcript path — there is nothing left to cut but the marker
  // itself; that is the true floor.
  if (serializedLength(envelope) >= MAX_ENVELOPE_CHARS) {
    envelope.summary = TRUNCATION_MARKER;
    delete envelope.detail;
  }

  return envelope;
}
