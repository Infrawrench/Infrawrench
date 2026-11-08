/**
 * The `node:http` to fetch adapter `server.ts` serves the API and the SPA
 * through, over a real socket.
 */
import { createServer, request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { toRequestListener, type FetchHandler } from "../request-listener";

let server: Server | undefined;

afterEach(async () => {
  const open = server;
  server = undefined;
  if (open) await new Promise((resolve) => open.close(resolve));
});

async function listen(handler: FetchHandler): Promise<string> {
  const created = createServer(toRequestListener(handler));
  server = created;
  await new Promise<void>((resolve) => created.listen(0, "127.0.0.1", resolve));
  const { port } = created.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

/** A raw request, for what `fetch` would not send (a missing `Host`). */
function raw(base: string, path: string, headers: Record<string, string>) {
  const url = new URL(base);
  return new Promise<{ status: number | undefined }>((resolve, reject) => {
    const req = httpRequest(
      { host: url.hostname, port: url.port, path, headers, setHost: false },
      (res) => {
        res.resume();
        res.on("end", () => resolve({ status: res.statusCode }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

describe("toRequestListener", () => {
  it("hands the handler the request's URL, method, headers and body", async () => {
    const base = await listen(async (request) =>
      Response.json({
        url: request.url,
        method: request.method,
        custom: request.headers.get("x-custom"),
        body: await request.text(),
      }),
    );
    const res = await fetch(`${base}/api/echo?x=1`, {
      method: "POST",
      headers: { "x-custom": "yes" },
      body: "hello",
    });
    expect(await res.json()).toEqual({
      url: `${base}/api/echo?x=1`,
      method: "POST",
      custom: "yes",
      body: "hello",
    });
  });

  it("sends a buffered body with its length rather than chunked", async () => {
    const base = await listen(async () => new Response("buffered"));
    const res = await fetch(base);
    expect(res.headers.get("content-length")).toBe("8");
    expect(res.headers.get("content-type")).toBe("text/plain;charset=UTF-8");
    expect(await res.text()).toBe("buffered");
  });

  it("sends every Set-Cookie header separately", async () => {
    const base = await listen(async () => {
      const headers = new Headers();
      headers.append("set-cookie", "a=1; Path=/");
      headers.append("set-cookie", "b=2; Path=/");
      return new Response(null, { status: 204, headers });
    });
    const res = await fetch(base);
    expect(res.status).toBe(204);
    expect(res.headers.getSetCookie()).toEqual(["a=1; Path=/", "b=2; Path=/"]);
  });

  it("streams a body that is not ready yet, headers first", async () => {
    let release: () => void = () => {};
    const base = await listen(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            async start(controller) {
              controller.enqueue(new TextEncoder().encode("data: one\n\n"));
              await new Promise<void>((resolve) => {
                release = resolve;
              });
              controller.enqueue(new TextEncoder().encode("data: two\n\n"));
              controller.close();
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        ),
    );
    const res = await fetch(base);
    // Headers arrive while the body is still open.
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    expect(res.headers.get("content-length")).toBeNull();
    const reader = res.body!.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toBe("data: one\n\n");
    release();
    let rest = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      rest += new TextDecoder().decode(value);
    }
    expect(rest).toBe("data: two\n\n");
  });

  it("stops reading the body when the client goes away", async () => {
    let cancelled: (reason: unknown) => void = () => {};
    const wasCancelled = new Promise((resolve) => {
      cancelled = resolve;
    });
    const base = await listen(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("tick"));
            },
            cancel(reason) {
              cancelled(reason);
            },
          }),
        ),
    );
    const client = new AbortController();
    const res = await fetch(base, { signal: client.signal });
    const reader = res.body!.getReader();
    await reader.read();
    client.abort();
    await expect(wasCancelled).resolves.toBeUndefined();
  });

  it("aborts the request's signal when the client goes away first", async () => {
    let aborted: () => void = () => {};
    const wasAborted = new Promise<void>((resolve) => {
      aborted = resolve;
    });
    const base = await listen(async (request) => {
      request.signal.addEventListener("abort", () => aborted());
      await wasAborted;
      return new Response("late");
    });
    const client = new AbortController();
    const pending = fetch(base, { signal: client.signal }).catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 50));
    client.abort();
    await pending;
    await expect(wasAborted).resolves.toBeUndefined();
  });

  it("serves the next request on a connection whose upload was never read", async () => {
    let calls = 0;
    const base = await listen(async () => {
      calls++;
      return new Response("ignored the body");
    });
    const first = await fetch(base, { method: "POST", body: "x".repeat(64 * 1024) });
    expect(await first.text()).toBe("ignored the body");
    const second = await fetch(base, { method: "POST", body: "y" });
    expect(await second.text()).toBe("ignored the body");
    expect(calls).toBe(2);
  });

  it("answers an empty 500 when the handler throws", async () => {
    const base = await listen(async () => {
      throw new Error("boom");
    });
    const res = await fetch(base);
    expect(res.status).toBe(500);
    expect(await res.text()).toBe("");
  });

  it("refuses a request without a Host header", async () => {
    const base = await listen(async () => new Response("unreachable"));
    expect(await raw(base, "/", {})).toEqual({ status: 400 });
  });
});
