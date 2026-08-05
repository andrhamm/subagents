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
    expect(res.choices?.[0]?.message?.content).toBe("hi");
    expect(res.usage?.prompt_tokens).toBe(5);
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
});
