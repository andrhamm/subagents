/**
 * Appends a marker only when a slice actually cut something, so a truncated
 * diagnostic (an HTTP error body, a non-JSON response, a malformed API
 * response dumped for debugging) never reads as complete when it isn't.
 */
export function markIfCut(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}
