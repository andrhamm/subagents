/**
 * Appends a marker only when a slice actually cut something, so a truncated
 * diagnostic (an HTTP error body, a non-JSON response, a malformed API
 * response dumped for debugging) never reads as complete when it isn't.
 */
export function markIfCut(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

/**
 * Tail-keeping counterpart to markIfCut: check runners print failures at the
 * END of their output, so in-loop coaching must keep the tail and mark what
 * was dropped from the front — never silently.
 */
export function markIfCutTail(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `[${text.length - limit} chars cut from the front]…${text.slice(-limit)}`;
}
