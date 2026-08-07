import type { Message, Usage } from "./types";

export interface TranscriptData {
  model: string;
  task: string;
  status: string;
  messages: Message[];
  usage: Usage[];
  /** Test gate output, when a write run had one. Envelope carries only the verdict. */
  test_output?: string;
}

/**
 * Persist the whole conversation, including tool results.
 * Saving only API responses makes questions like "what did the model actually
 * see?" unanswerable after the fact.
 */
export async function writeTranscript(path: string, data: TranscriptData): Promise<void> {
  await Bun.write(path, JSON.stringify(data, null, 1));
}
