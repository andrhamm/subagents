export interface SamplingParams {
  temperature?: number;
  top_p?: number;
  top_k?: number;
}

export interface ToolSchema {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: {
      type: "object";
      properties: Record<string, unknown>;
      required?: string[];
    };
  };
}

export interface ToolCall {
  id: string;
  type?: "function";
  function: { name: string; arguments: string };
}

export interface AssistantMessage {
  role: "assistant";
  content: string | null;
  tool_calls?: ToolCall[];
}

export type Message =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | AssistantMessage
  | { role: "tool"; tool_call_id: string; content: string };

export interface Usage {
  prompt_tokens?: number;
  completion_tokens?: number;
}

export interface ChatRequest {
  model: string;
  messages: Message[];
  tools?: ToolSchema[];
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  top_k?: number;
}

// Wire shapes: what an arbitrary OpenAI-compatible HTTP server actually
// sends. `base.ts` does `JSON.parse(text) as ChatResponse` with no
// validation, so every field below is under the server's control, not ours —
// declaring it required just lets the compiler tell callers a lie. Every
// field an arbitrary server could omit or malform is optional here, which
// forces a guard at each use in loop.ts instead of a runtime crash. Contrast
// with `AssistantMessage`/`ToolCall` above, which stay strict because those
// are constructed by our own code for the message history we send back.
export interface WireToolCall {
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

export interface WireMessage {
  role?: string;
  content?: string | null;
  tool_calls?: WireToolCall[];
}

export interface WireChoice {
  message?: WireMessage;
  finish_reason?: string;
}

export interface ChatResponse {
  choices?: WireChoice[];
  usage?: Usage;
}

export interface Backend {
  chat(req: ChatRequest, timeoutMs: number): Promise<ChatResponse>;
}
