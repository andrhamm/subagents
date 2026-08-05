import type { Backend, ChatRequest, ChatResponse } from "../types";
import { markIfCut } from "../text";

export class BackendError extends Error {}

export class OpenAIBackend implements Backend {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey?: string,
  ) {}

  async chat(req: ChatRequest, timeoutMs: number): Promise<ChatResponse> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.apiKey) headers["authorization"] = `Bearer ${this.apiKey}`;

    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify(req),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      throw new BackendError(
        `request to ${this.baseUrl} failed: ${e instanceof Error ? e.message : String(e)}`,
        { cause: e },
      );
    }

    const text = await res.text();
    if (!res.ok) {
      throw new BackendError(`HTTP ${res.status}: ${markIfCut(text, 500)}`);
    }
    try {
      return JSON.parse(text) as ChatResponse;
    } catch (e) {
      throw new BackendError(
        `non-JSON response from ${this.baseUrl}: ${markIfCut(text, 200)}`,
        { cause: e },
      );
    }
  }
}
