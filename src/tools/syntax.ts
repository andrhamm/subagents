const LOADERS: Record<string, "ts" | "tsx" | "js" | "jsx"> = {
  ".ts": "ts", ".tsx": "tsx", ".js": "js", ".jsx": "jsx",
};

/**
 * In-process parse check for freshly written content — milliseconds, no
 * subprocess. A malformed edit is the dominant small-model write failure,
 * and this note reaches the model in the same turn the damage happened,
 * instead of surfacing as a red gate after the loop ends. Returns "" for
 * clean or non-JS/TS content; never throws (the write already succeeded —
 * the note coaches, it does not veto).
 */
export function syntaxNote(path: string, content: string): string {
  const dot = path.lastIndexOf(".");
  const loader = dot === -1 ? undefined : LOADERS[path.slice(dot)];
  if (!loader) return "";
  try {
    new Bun.Transpiler({ loader }).transformSync(content);
    return "";
  } catch (e) {
    const first = String(
      e instanceof AggregateError ? (e.errors[0] ?? e) : e,
    ).split("\n")[0];
    return `\n[SYNTAX: ${first} — fix before finishing.]`;
  }
}
