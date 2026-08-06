import { describe, it, expect, afterEach } from "bun:test";
import { OpenAIBackend, BackendError } from "../../src/backends/base";

let server: ReturnType<typeof Bun.serve> | undefined;

afterEach(() => {
  server?.stop(true);
  server = undefined;
});

function serve(handler: (req: Request) => Response | Promise<Response>): string {
  server = Bun.serve({ port: 0, fetch: handler });
  return `http://127.0.0.1:${server.port}/v1`;
}

describe("OpenAIBackend", () => {
  it("posts to /chat/completions and returns the parsed body", async () => {
    let seenPath = "";
    let seenBody: any = null;
    const url = serve(async (req) => {
      seenPath = new URL(req.url).pathname;
      seenBody = await req.json();
      return Response.json({
        choices: [{ message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 5, completion_tokens: 2 },
      });
    });
    const res = await new OpenAIBackend(url).chat(
      { model: "m", messages: [{ role: "user", content: "yo" }] }, 5000);
    expect(seenPath).toBe("/v1/chat/completions");
    expect(seenBody.model).toBe("m");
    expect(res?.choices?.[0]?.message?.content).toBe("hi");
    expect(res?.usage?.prompt_tokens).toBe(5);
  });

  it("sends an Authorization header only when a key is given", async () => {
    const seen: Array<string | null> = [];
    const url = serve((req) => {
      seen.push(req.headers.get("authorization"));
      return Response.json({ choices: [] });
    });
    await new OpenAIBackend(url).chat({ model: "m", messages: [] }, 5000);
    await new OpenAIBackend(url, "sk-test").chat({ model: "m", messages: [] }, 5000);
    expect(seen[0]).toBeNull();
    expect(seen[1]).toBe("Bearer sk-test");
  });

  it("throws BackendError carrying the server's message on HTTP error", async () => {
    const url = serve(() => new Response("context length exceeded", { status: 500 }));
    const call = new OpenAIBackend(url).chat({ model: "m", messages: [] }, 5000);
    await expect(call).rejects.toThrow(BackendError);
    await expect(call).rejects.toThrow(/500.*context length exceeded/s);
  });

  it("throws BackendError on a non-JSON body", async () => {
    const url = serve(() => new Response("<html>nope</html>"));
    await expect(new OpenAIBackend(url).chat({ model: "m", messages: [] }, 5000))
      .rejects.toThrow(/non-JSON/);
  });

  it("throws BackendError on transport failure with diagnostic info", async () => {
    const url = "http://127.0.0.1:1/v1";
    const call = new OpenAIBackend(url).chat({ model: "m", messages: [] }, 5000);
    await expect(call).rejects.toThrow(BackendError);
    await expect(call).rejects.toThrow(/request to http:\/\/127\.0\.0\.1:1\/v1 failed: .+/);
  });

  it("carries the original transport error as .cause so its stack survives", async () => {
    const url = "http://127.0.0.1:1/v1";
    try {
      await new OpenAIBackend(url).chat({ model: "m", messages: [] }, 5000);
      throw new Error("expected chat() to throw");
    } catch (e) {
      expect(e).toBeInstanceOf(BackendError);
      expect((e as BackendError).cause).toBeInstanceOf(Error);
    }
  });

  it("marks a truncated HTTP error body with an ellipsis when it exceeds the 500-char slice", async () => {
    const url = serve(() => new Response("x".repeat(600), { status: 500 }));
    const call = new OpenAIBackend(url).chat({ model: "m", messages: [] }, 5000);
    await expect(call).rejects.toThrow(/…$/);
  });

  it("does not append an ellipsis to an HTTP error body that fits the slice", async () => {
    const url = serve(() => new Response("short error", { status: 500 }));
    const call = new OpenAIBackend(url).chat({ model: "m", messages: [] }, 5000);
    await expect(call).rejects.not.toThrow(/…/);
  });

  it("marks a truncated non-JSON body with an ellipsis when it exceeds the 200-char slice", async () => {
    const url = serve(() => new Response("y".repeat(300)));
    const call = new OpenAIBackend(url).chat({ model: "m", messages: [] }, 5000);
    await expect(call).rejects.toThrow(/…$/);
  });

  it("does not append an ellipsis to a non-JSON body that fits the slice", async () => {
    const url = serve(() => new Response("nope"));
    const call = new OpenAIBackend(url).chat({ model: "m", messages: [] }, 5000);
    await expect(call).rejects.not.toThrow(/…/);
  });

  // Second-round critical fix: a server answering HTTP 200 with the JSON
  // literal `null` (or any other top-level non-object — an array, a number,
  // a string) parses successfully via JSON.parse, so the earlier non-JSON
  // guard never catches it. The old `as ChatResponse` cast then lied to
  // every caller, and `res.usage` in loop.ts threw straight out of runLoop —
  // the same failure class as the tool_calls fix, one level up the chain.
  it("returns null, not a lying ChatResponse, when the body parses to JSON null", async () => {
    const url = serve(() => new Response("null", { headers: { "content-type": "application/json" } }));
    const res = await new OpenAIBackend(url).chat({ model: "m", messages: [] }, 5000);
    expect(res).toBeNull();
  });

  it("returns null when the body parses to a non-object JSON value (an array)", async () => {
    const url = serve(() => Response.json([1, 2, 3]));
    const res = await new OpenAIBackend(url).chat({ model: "m", messages: [] }, 5000);
    expect(res).toBeNull();
  });

  it("returns null when the body parses to a bare JSON number", async () => {
    const url = serve(() => new Response("42", { headers: { "content-type": "application/json" } }));
    const res = await new OpenAIBackend(url).chat({ model: "m", messages: [] }, 5000);
    expect(res).toBeNull();
  });
});
