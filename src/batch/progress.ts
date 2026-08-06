import type { BatchState } from "./scheduler";

/**
 * The poll target for background callers: one JSON line, rewritten whole on
 * every state change. Deliberately not atomic — a torn read costs the
 * poller one re-poll, and a rename dance would buy nothing a poller needs.
 */
export async function writeProgress(path: string, state: BatchState): Promise<void> {
  await Bun.write(path, `${JSON.stringify(state)}\n`);
}
