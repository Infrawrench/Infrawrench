/**
 * `node:http` to fetch: serve a Node request with a handler that takes a web
 * `Request` and answers a web `Response`, which is what `api` is.
 *
 * Small on purpose, and the part of `@hono/node-server`'s `getRequestListener`
 * this server used (it is what `server.ts` ran before the API left Hono):
 *
 * - the URL is the request target on `http(s)://<Host>`, the scheme from the
 *   socket; a request with no `Host`, or one that will not parse, is a 400;
 * - the body of anything but GET and HEAD streams in on demand, and an upload
 *   the handler did not finish reading is drained (briefly, then the socket is
 *   closed) so a keep-alive connection is not left stuck behind it;
 * - the request's `signal` aborts when the client goes away first;
 * - the response streams out with backpressure, a body that finishes at once
 *   gets a `Content-Length`, one that does not gets its headers flushed so a
 *   stream (SSE) starts immediately, and reading stops when the client goes;
 * - a handler that throws answers an empty 500.
 *
 * WebSocket upgrades never reach it: `server.ts` takes them on the server's
 * `upgrade` event.
 */
import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from "node:http";
import { Readable } from "node:stream";

export type FetchHandler = (request: Request) => Promise<Response>;

/** An unread upload is drained for this long after the response, then the socket closes. */
const DRAIN_TIMEOUT_MS = 500;

/** The type a body is sent under when the handler named none, as the old adapter did. */
const DEFAULT_CONTENT_TYPE = "text/plain; charset=UTF-8";

export function toRequestListener(
  handler: FetchHandler,
): (incoming: IncomingMessage, outgoing: ServerResponse) => void {
  return (incoming, outgoing) => {
    void serve(handler, incoming, outgoing).catch((error: unknown) => {
      console.error("[http] response failed:", error);
      if (!outgoing.headersSent) outgoing.writeHead(500);
      outgoing.destroy();
    });
  };
}

async function serve(
  handler: FetchHandler,
  incoming: IncomingMessage,
  outgoing: ServerResponse,
): Promise<void> {
  const abort = new AbortController();
  const request = toWebRequest(incoming, abort.signal);
  if (!request) {
    outgoing.writeHead(400);
    outgoing.end();
    return;
  }
  outgoing.once("close", () => {
    if (!outgoing.writableFinished) abort.abort(new Error("Client connection prematurely closed."));
  });
  if (request.body) {
    outgoing.once("finish", () => drainUnread(incoming));
  }

  let response: Response;
  try {
    response = await handler(request);
  } catch (error) {
    console.error("[http] handler failed:", error);
    response = new Response(null, { status: 500 });
  }
  await writeResponse(response, outgoing);
}

/** Whether the request came over TLS (a `TLSSocket` carries `encrypted: true`). */
function isEncrypted(incoming: IncomingMessage): boolean {
  const socket = incoming.socket;
  return "encrypted" in socket && socket.encrypted === true;
}

/** The web `Request` for `incoming`, or null when its target or `Host` will not make a URL. */
function toWebRequest(incoming: IncomingMessage, signal: AbortSignal): Request | null {
  const url = requestUrl(incoming);
  if (!url) return null;
  const headers = new Headers();
  const raw = incoming.rawHeaders;
  for (let i = 0; i + 1 < raw.length; i += 2) {
    const name = raw[i];
    const value = raw[i + 1];
    // HTTP/2 pseudo-headers (`:path`) are not headers.
    if (name === undefined || value === undefined || name.startsWith(":")) continue;
    headers.append(name, value);
  }
  const method = incoming.method ?? "GET";
  if (method === "GET" || method === "HEAD") return new Request(url, { method, headers, signal });
  const init: StreamingRequestInit = {
    method,
    headers,
    signal,
    body: lazyBody(incoming),
    duplex: "half",
  };
  return new Request(url, init);
}

/**
 * A request whose body is a stream must say it is sent half duplex; the DOM
 * typings this package compiles against predate the field.
 */
interface StreamingRequestInit extends RequestInit {
  readonly duplex: "half";
}

function requestUrl(incoming: IncomingMessage): string | null {
  const target = incoming.url ?? "";
  try {
    if (/^https?:\/\//.test(target)) return new URL(target).href;
    const host = incoming.headers.host;
    if (!host || !target.startsWith("/")) return null;
    const url = new URL(`${isEncrypted(incoming) ? "https" : "http"}://${host}${target}`);
    // A `Host` carrying anything a URL reads as more than a host (userinfo, a
    // path) parses to some other host: refuse it rather than route by it.
    if (url.hostname !== host.replace(/:\d+$/, "").toLowerCase()) return null;
    return url.href;
  } catch {
    return null;
  }
}

/** The upload, read from the socket only once the handler starts reading it. */
function lazyBody(incoming: IncomingMessage): ReadableStream<Uint8Array> {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        reader ??= Readable.toWeb(incoming).getReader();
        const { done, value } = await reader.read();
        if (done) controller.close();
        else controller.enqueue(value);
      },
      async cancel(reason) {
        await reader?.cancel(reason);
      },
    },
    // Nothing is pulled until someone reads: an unread upload stays in the socket.
    { highWaterMark: 0 },
  );
}

/**
 * After the response: let the rest of an upload nobody read go by, so the
 * connection can carry its next request, and close it if that takes too long.
 */
function drainUnread(incoming: IncomingMessage): void {
  if (incoming.readableEnded || incoming.destroyed) return;
  const timer = setTimeout(() => {
    if (!incoming.readableEnded) incoming.socket.destroy();
  }, DRAIN_TIMEOUT_MS);
  timer.unref();
  incoming.once("end", () => clearTimeout(timer));
  incoming.resume();
}

function outgoingHeaders(response: Response): OutgoingHttpHeaders {
  const out: OutgoingHttpHeaders = {};
  for (const [name, value] of response.headers) {
    if (name !== "set-cookie") out[name] = value;
  }
  const cookies = response.headers.getSetCookie();
  if (cookies.length > 0) out["set-cookie"] = cookies;
  if (response.body && out["content-type"] === undefined)
    out["content-type"] = DEFAULT_CONTENT_TYPE;
  return out;
}

/** A read that has already settled, or undefined when it would have to wait. */
async function readIfReady(
  read: Promise<ReadableStreamReadResult<Uint8Array>>,
): Promise<ReadableStreamReadResult<Uint8Array> | undefined> {
  return Promise.race([read, Promise.resolve().then(() => undefined)]);
}

async function writeResponse(response: Response, outgoing: ServerResponse): Promise<void> {
  const headers = outgoingHeaders(response);
  if (!response.body) {
    outgoing.writeHead(response.status, headers);
    outgoing.end();
    return;
  }

  // What the body has ready right away: all of it, for a buffered response,
  // which then goes out with a length rather than chunked.
  const reader = response.body.getReader();
  const ready: Uint8Array[] = [];
  let pending: Promise<ReadableStreamReadResult<Uint8Array>> | undefined;
  let done = false;
  if (headers["transfer-encoding"] !== "chunked") {
    for (let attempt = 0; attempt < 3 && !done; attempt++) {
      pending ??= reader.read();
      const result = await readIfReady(pending);
      if (!result) {
        // One macrotask's grace for a body that is buffered but not yet queued.
        if (attempt === 0) await new Promise((resolve) => setTimeout(resolve));
        else break;
        continue;
      }
      pending = undefined;
      if (result.value) ready.push(result.value);
      done = result.done;
    }
    if (done && headers["content-length"] === undefined) {
      headers["content-length"] = ready.reduce((total, chunk) => total + chunk.byteLength, 0);
    }
  }

  outgoing.writeHead(response.status, headers);
  for (const chunk of ready) outgoing.write(chunk);
  if (done) {
    outgoing.end();
    return;
  }
  if (ready.length === 0) outgoing.flushHeaders();
  await pump(reader, pending, outgoing);
}

/** Copy the rest of the body to the socket, honouring backpressure, until either side stops. */
async function pump(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  pending: Promise<ReadableStreamReadResult<Uint8Array>> | undefined,
  outgoing: ServerResponse,
): Promise<void> {
  const stop = () => {
    reader.cancel().catch(() => {});
  };
  outgoing.once("close", stop);
  try {
    let next = pending ?? reader.read();
    for (;;) {
      const { done, value } = await next;
      if (done || outgoing.destroyed) break;
      if (!outgoing.write(value)) await drained(outgoing);
      next = reader.read();
    }
    if (!outgoing.destroyed) outgoing.end();
  } catch (error) {
    // The body failed mid-stream: the status line is gone, so all that is
    // left is to cut the response short rather than end it as if complete.
    outgoing.destroy(error instanceof Error ? error : new Error(String(error)));
  } finally {
    outgoing.off("close", stop);
  }
}

function drained(outgoing: ServerResponse): Promise<void> {
  return new Promise((resolve) => {
    const settle = () => {
      outgoing.off("drain", settle);
      outgoing.off("close", settle);
      resolve();
    };
    outgoing.once("drain", settle);
    outgoing.once("close", settle);
  });
}
