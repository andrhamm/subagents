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

  return {
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
}
