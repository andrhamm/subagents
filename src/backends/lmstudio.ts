/**
 * Read-only adjunct to LM Studio's OpenAI-compat surface: its management API
 * (`/api/v0`) knows the loaded model's context length, which the chat API
 * never reports. Everything here is advisory — a failure degrades an
 * envelope field to null, it never costs the run.
 *
 * Wire shapes live-verified 2026-08-07 against the lan-host server:
 * - GET /api/v0/models/{id} accepts slash-bearing ids as raw path segments
 *   ("google/gemma-4-e2b") and answers an unknown id with HTTP 400
 *   {"error":"Model with identifier '...' not found"}.
 * - A loaded model carries `loaded_context_length` (the serving config)
 *   alongside `max_context_length` (the model's ceiling); an unloaded one
 *   only the latter. Multimodal models report type "vlm", not "llm" — do
 *   not filter on type.
 */

// Wire shape: every field is server-controlled, so every field is optional.
interface V0Model {
  loaded_context_length?: unknown;
  max_context_length?: unknown;
}

const positive = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null;

// Successful lookups memoized per (baseUrl, model) — the same key batch
// groups jobs by — so a 20-job group costs one GET. The promise lands in the
// map before the fetch resolves, letting concurrent jobs share the in-flight
// request; a null resolution is evicted so the next run retries instead of
// pinning a transient failure for the whole process.
const cache = new Map<string, Promise<number | null>>();

/**
 * The loaded model's context length in tokens, or null when it isn't
 * knowable (unreachable host, unknown id, malformed body, timeout). Prefers
 * `loaded_context_length` — the config actually serving requests — over the
 * model's `max_context_length` ceiling. Never throws.
 */
export function fetchContextLimit(
  baseUrl: string,
  model: string,
  opts: { timeoutMs?: number } = {},
): Promise<number | null> {
  const key = `${baseUrl}::${model}`;
  const hit = cache.get(key);
  if (hit) return hit;

  // The management API hangs off the host root, beside /v1, not under it.
  const host = baseUrl.replace(/\/v1$/, "");
  const lookup = (async (): Promise<number | null> => {
    try {
      const res = await fetch(`${host}/api/v0/models/${model}`, {
        signal: AbortSignal.timeout(opts.timeoutMs ?? 5000),
      });
      if (!res.ok) return null;
      const body = (await res.json()) as V0Model;
      if (body === null || typeof body !== "object" || Array.isArray(body)) return null;
      return positive(body.loaded_context_length) ?? positive(body.max_context_length);
    } catch {
      return null;
    }
  })();

  cache.set(key, lookup);
  void lookup.then((limit) => {
    if (limit === null) cache.delete(key);
  });
  return lookup;
}

export interface ContextExceeded {
  /** Prompt size the server counted, when the message carried it. */
  needed: number | null;
  /** Context size the server enforced, when the message carried it. */
  limit: number | null;
}

// Live-captured 2026-08-07: a /v1/chat/completions HTTP 400 whose body nests
// an escaped engine error — `"type":"exceed_context_size_error"` with
// message `request (N tokens) exceeds the available context size (M tokens),
// try increasing it`. Matched as text because the loop's error detail is the
// whole `HTTP 400: <body>` string, not parsed JSON.
const EXCEEDED_MESSAGE =
  /request \((\d+) tokens\) exceeds the available context size \((\d+) tokens\)/;
const EXCEEDED_TYPE = /exceed_context_size_error/;

/**
 * Recognize a context-window-exceeded backend error in a loop error detail.
 * Returns the token counts when the message shape carries them, a countless
 * marker when only the error type survives a wording drift, and null for
 * anything that isn't this error.
 */
export function parseContextExceeded(detail: string): ContextExceeded | null {
  const m = EXCEEDED_MESSAGE.exec(detail);
  if (m) return { needed: Number(m[1]), limit: Number(m[2]) };
  if (EXCEEDED_TYPE.test(detail)) return { needed: null, limit: null };
  return null;
}
