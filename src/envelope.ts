import type { LoopResult } from "./loop";

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
}

export interface EnvelopeInputs {
  wallSecs: number;
  transcript: string;
  contextLimit: number | null;
}

const round = (n: number, places: number): number => {
  const f = 10 ** places;
  return Math.round(n * f) / f;
};

// The envelope's small size is the entire reason it exists — a measured run
// burned 165,362 delegate tokens and returned ~850 to the caller. `summary`
// and `detail` are the only fields whose length the caller (via the
// delegate's own output) controls, so they are the only ones that need a
// cap; every other field is a bounded number or a short caller-supplied path.
const MAX_ENVELOPE_CHARS = 600;
const TRUNCATION_MARKER = "...[truncated, see transcript]";

/**
 * Shrink `envelope[field]` just enough to bring the whole serialized
 * envelope back under `MAX_ENVELOPE_CHARS`, then mark the cut so a truncated
 * field never reads as a complete one — the transcript still has the rest.
 *
 * No re-measuring loop: removing N characters from a JSON string value can
 * only shrink its encoded form by at least N bytes (an escaped character
 * like `"` costs 2 bytes and saves 2 when removed), so cutting
 * `over + marker.length` characters and appending the marker is guaranteed
 * to land the whole envelope under budget in a single pass.
 */
function shrinkField(envelope: Envelope, field: "summary" | "detail"): void {
  const text = field === "summary" ? envelope.summary : envelope.detail;
  if (!text) return;
  const over = JSON.stringify(envelope).length - MAX_ENVELOPE_CHARS + 1;
  if (over <= 0) return;
  const cut = Math.min(text.length, over + TRUNCATION_MARKER.length);
  const shrunk = text.slice(0, text.length - cut) + TRUNCATION_MARKER;
  if (field === "summary") envelope.summary = shrunk;
  else envelope.detail = shrunk;
}

export function buildEnvelope(r: LoopResult, o: EnvelopeInputs): Envelope {
  const prompts = r.usage.map((u) => u.prompt_tokens ?? 0);
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
    local_tokens: r.usage.reduce(
      (sum, u) => sum + (u.prompt_tokens ?? 0) + (u.completion_tokens ?? 0), 0),
    transcript: o.transcript,
  };

  // Detail is supplementary — give it up first. Only reach into summary, the
  // field a naive caller reads, once detail alone can't make room.
  shrinkField(envelope, "detail");
  shrinkField(envelope, "summary");

  return envelope;
}
