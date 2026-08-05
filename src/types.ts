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

export interface ChatResponse {
  choices?: Array<{ message: AssistantMessage; finish_reason?: string }>;
  usage?: Usage;
}

export interface Backend {
  chat(req: ChatRequest, timeoutMs: number): Promise<ChatResponse>;
}
