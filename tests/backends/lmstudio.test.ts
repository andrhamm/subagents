import { describe, it, expect, afterEach } from "bun:test";
import { fetchContextLimit, parseContextExceeded } from "../../src/backends/lmstudio";

// Live-verified 2026-08-07 against LM Studio on lan-host: GET
// /api/v0/models/{id} (slash ids accepted raw), loaded models carry
// loaded_context_length alongside max_context_length, unloaded ones only
// max_context_length, unknown ids answer HTTP 400 {"error":"..."}.
const LOADED = {
  id: "qwen3-coder-next",
  object: "model",
  type: "llm",
  state: "loaded",
  max_context_length: 262144,
  loaded_context_length: 32768,
};

// Verbatim /v1/chat/completions HTTP 400 body captured live 2026-08-07 by
// sending a >262k-token prompt to the loaded model. The inner JSON arrives
// as an escaped string inside the outer "error" field.
export const LIVE_EXCEEDED_BODY =
  '{"error":"Engine protocol predict request returned 400: {\\"error\\":{\\"code\\":400,\\"message\\":\\"request (270010 tokens) exceeds the available context size (262144 tokens), try increasing it\\",\\"type\\":\\"exceed_context_size_error\\",\\"n_prompt_tokens\\":270010,\\"n_ctx\\":262144}}"}';

let server: ReturnType<typeof Bun.serve> | undefined;

afterEach(() => {
  server?.stop(true);
  server = undefined;
});

function serve(handler: (req: Request) => Response | Promise<Response>): string {
  server = Bun.serve({ port: 0, fetch: handler });
  return `http://127.0.0.1:${server.port}/v1`;
}

describe("fetchContextLimit", () => {
  it("GETs /api/v0/models/{id} relative to the host, not the /v1 prefix", async () => {
    let seenPath = "";
    const url = serve((req) => {
      seenPath = new URL(req.url).pathname;
      return Response.json(LOADED);
    });
    await fetchContextLimit(url, "qwen3-coder-next");
    expect(seenPath).toBe("/api/v0/models/qwen3-coder-next");
  });

  it("passes a slash-bearing model id through as path segments, as the live server accepts", async () => {
    let seenPath = "";
    const url = serve((req) => {
      seenPath = new URL(req.url).pathname;
      return Response.json({ ...LOADED, id: "google/gemma-4-e2b" });
    });
    await fetchContextLimit(url, "google/gemma-4-e2b");
    expect(seenPath).toBe("/api/v0/models/google/gemma-4-e2b");
  });

  it("prefers loaded_context_length — the serving config — over the model's max", async () => {
    const url = serve(() => Response.json(LOADED));
    expect(await fetchContextLimit(url, "qwen3-coder-next")).toBe(32768);
  });

  it("falls back to max_context_length when the model is not loaded", async () => {
    const url = serve(() =>
      Response.json({ id: "m", state: "not-loaded", max_context_length: 131072 }));
    expect(await fetchContextLimit(url, "m")).toBe(131072);
  });

  it("returns null on the live HTTP 400 unknown-id shape", async () => {
    const url = serve(() =>
      Response.json({ error: "Model with identifier 'ghost' not found" }, { status: 400 }));
    expect(await fetchContextLimit(url, "ghost")).toBeNull();
  });

  it("returns null on a non-JSON body", async () => {
    const url = serve(() => new Response("<html>nope</html>"));
    expect(await fetchContextLimit(url, "m")).toBeNull();
  });

  it("returns null when neither context field is a positive number", async () => {
    const url = serve(() => Response.json({ id: "m", max_context_length: "big" }));
    expect(await fetchContextLimit(url, "m")).toBeNull();
  });

  it("returns null instead of throwing when the host is unreachable", async () => {
    expect(await fetchContextLimit("http://127.0.0.1:1/v1", "m")).toBeNull();
  });

  it("returns null when the server exceeds the timeout", async () => {
    const url = serve(async () => {
      await new Promise((r) => setTimeout(r, 400));
      return Response.json(LOADED);
    });
    expect(await fetchContextLimit(url, "m", { timeoutMs: 50 })).toBeNull();
  });

  it("memoizes a successful lookup per (baseUrl, model) — one GET per batch group", async () => {
    let hits = 0;
    const url = serve(() => {
      hits++;
      return Response.json(LOADED);
    });
    expect(await fetchContextLimit(url, "qwen3-coder-next")).toBe(32768);
    expect(await fetchContextLimit(url, "qwen3-coder-next")).toBe(32768);
    expect(hits).toBe(1);
  });

  it("does not memoize a failed lookup — the next run retries", async () => {
    let hits = 0;
    const url = serve(() => {
      hits++;
      return hits === 1
        ? new Response("boom", { status: 500 })
        : Response.json(LOADED);
    });
    expect(await fetchContextLimit(url, "qwen3-coder-next")).toBeNull();
    expect(await fetchContextLimit(url, "qwen3-coder-next")).toBe(32768);
    expect(hits).toBe(2);
  });
});

describe("parseContextExceeded", () => {
  it("extracts both token counts from the live error shape, wrapped in the loop's HTTP prefix", () => {
    const detail = `HTTP 400: ${LIVE_EXCEEDED_BODY}`;
    expect(parseContextExceeded(detail)).toEqual({ needed: 270010, limit: 262144 });
  });

  it("recognizes the error type token even if the message wording drifts", () => {
    const detail = 'HTTP 400: {"error":"...\\"type\\":\\"exceed_context_size_error\\"..."}';
    expect(parseContextExceeded(detail)).toEqual({ needed: null, limit: null });
  });

  it("returns null for a generic HTTP 400", () => {
    expect(parseContextExceeded('HTTP 400: {"error":"Invalid \'messages\'"}')).toBeNull();
  });

  it("returns null for a transport failure message", () => {
    expect(parseContextExceeded("request to http://x failed: connection refused")).toBeNull();
  });
});
