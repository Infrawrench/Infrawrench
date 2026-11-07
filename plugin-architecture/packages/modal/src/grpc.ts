/**
 * gRPC over the host's plain HTTP service.
 *
 * Modal's API is gRPC-only (`modal.client.ModalClient` on api.modal.com, the
 * service the official Python, JavaScript and Go SDKs call). Its Envoy front
 * end also accepts gRPC over HTTP/1.1, which is what makes it reachable
 * through `HostServices.http` with no new dependency and no HTTP/2 client:
 *
 * - A request is a POST to `/modal.client.ModalClient/<Method>` with
 *   `content-type: application/grpc`, `te: trailers`, and the message
 *   length-prefixed (one flag byte, a big-endian uint32 length, the bytes).
 * - A response body is the same framing, once for a unary call and once per
 *   item for a server-streaming call.
 * - Errors before the first message arrive "trailers-only": `grpc-status` and
 *   `grpc-message` are plain response headers with an empty body, so they
 *   survive HTTP/1.1 and any fetch implementation.
 * - Otherwise the closing `grpc-status` is a real trailer: `0` on success, or
 *   the failure of a stream that broke after its first messages. The call asks
 *   the host for trailers (`readTrailers`), which both hosts read over
 *   `node:https`. A server-streaming answer is only taken as complete when that
 *   status says so: a stream cut off at a frame boundary is well framed, and
 *   the billing report it carries would zero the days it never returned. With
 *   no status in the headers or trailers, or a host that cannot read trailers,
 *   the stream throws rather than guess. A unary answer needs no trailer to be
 *   trusted, since its one message cannot be cut short and still unframe.
 *
 * `te` is a forbidden header for browser fetch, which is why every call goes
 * through the host's HTTP service (Node on the server, the main process on
 * desktop) rather than the renderer's own fetch.
 *
 * Protocol: https://github.com/grpc/grpc/blob/master/doc/PROTOCOL-HTTP2.md
 */

import type { HttpHostServices } from "@infrawrench/plugin-base";
import { ListPageError } from "@infrawrench/plugin-base";

export const DEFAULT_SERVER_URL = "https://api.modal.com";
const SERVICE = "modal.client.ModalClient";

/**
 * The SDK protocol level the requests speak. Modal gates behaviour on
 * `x-modal-client-version`; 1.0.0 is what its JavaScript and Go SDKs send
 * ("behaves like this Python SDK version"), and the client type is theirs
 * (`ClientType.CLIENT_TYPE_LIBMODAL_JS = 8`), because these calls follow the
 * same protocol they do.
 */
const CLIENT_VERSION = "1.0.0";
const CLIENT_TYPE = "8";

export interface ModalContext {
  tokenId: string;
  tokenSecret: string;
  serverUrl: string;
  http?: HttpHostServices;
  caCert?: string;
}

/** gRPC status codes this plugin branches on. */
export const GrpcCode = {
  OK: 0,
  CANCELLED: 1,
  UNKNOWN: 2,
  INVALID_ARGUMENT: 3,
  DEADLINE_EXCEEDED: 4,
  NOT_FOUND: 5,
  ALREADY_EXISTS: 6,
  PERMISSION_DENIED: 7,
  RESOURCE_EXHAUSTED: 8,
  FAILED_PRECONDITION: 9,
  UNIMPLEMENTED: 12,
  INTERNAL: 13,
  UNAVAILABLE: 14,
  UNAUTHENTICATED: 16,
} as const;

export class ModalApiError extends Error {
  constructor(
    readonly method: string,
    readonly code: number,
    readonly grpcMessage: string,
    readonly httpStatus?: number,
  ) {
    super(
      code === GrpcCode.UNAUTHENTICATED
        ? `Modal rejected the token for ${method}: ${grpcMessage || "unauthenticated"}. Check the token ID and secret.`
        : `Modal ${method} failed (${codeName(code)}): ${grpcMessage || "no message"}`,
    );
    this.name = "ModalApiError";
  }
}

function codeName(code: number): string {
  for (const [name, value] of Object.entries(GrpcCode)) if (value === code) return name;
  return `code ${code}`;
}

/** The gRPC code of a thrown error, or undefined when it is not a Modal API error. */
export function grpcCodeOf(err: unknown): number | undefined {
  return err instanceof ModalApiError ? err.code : undefined;
}

function frame(message: Uint8Array): Uint8Array {
  const out = new Uint8Array(5 + message.length);
  new DataView(out.buffer).setUint32(1, message.length, false);
  out.set(message, 5);
  return out;
}

/**
 * Split a response body into its length-prefixed messages. Throws on a
 * truncated frame (a stream cut short) and on a compressed one (the plugin
 * never advertises `grpc-accept-encoding`, so the server must not send one).
 */
export function unframe(body: Uint8Array, method: string): Uint8Array[] {
  const out: Uint8Array[] = [];
  let pos = 0;
  while (pos < body.length) {
    if (pos + 5 > body.length) {
      throw new ModalApiError(method, GrpcCode.INTERNAL, "response ended inside a frame header");
    }
    const compressed = body[pos]! & 1;
    const length = new DataView(body.buffer, body.byteOffset + pos + 1, 4).getUint32(0, false);
    if (pos + 5 + length > body.length) {
      throw new ModalApiError(method, GrpcCode.INTERNAL, "response ended inside a message");
    }
    if (compressed) {
      throw new ModalApiError(method, GrpcCode.INTERNAL, "unexpected compressed message");
    }
    out.push(body.subarray(pos + 5, pos + 5 + length));
    pos += 5 + length;
  }
  return out;
}

function header(headers: Record<string, string>, name: string): string | undefined {
  for (const [k, v] of Object.entries(headers)) if (k.toLowerCase() === name) return v;
  return undefined;
}

function decodeGrpcMessage(raw: string | undefined): string {
  if (!raw) return "";
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

async function post(
  ctx: ModalContext,
  method: string,
  request: Uint8Array,
): Promise<{
  status: number;
  headers: Record<string, string>;
  body: Uint8Array;
  /** Absent when the transport cannot read trailers. */
  trailers?: Record<string, string>;
}> {
  const url = `${ctx.serverUrl.replace(/\/+$/, "")}/${SERVICE}/${method}`;
  const headers: Record<string, string> = {
    "content-type": "application/grpc",
    te: "trailers",
    "x-modal-client-type": CLIENT_TYPE,
    "x-modal-client-version": CLIENT_VERSION,
    "x-modal-token-id": ctx.tokenId,
    "x-modal-token-secret": ctx.tokenSecret,
    // gRPC's :authority is stripped before Modal's servers read it, so the
    // SDKs repeat the host in a header of their own.
    "x-modal-host": new URL(url).hostname,
  };
  const body = frame(request);
  if (ctx.http) {
    const res = await ctx.http.request({
      url,
      method: "POST",
      headers,
      body,
      responseEncoding: "binary",
      readTrailers: true,
      ...(ctx.caCert ? { caCert: ctx.caCert } : {}),
    });
    return {
      status: res.status,
      headers: res.headers,
      body: res.rawBody ?? new TextEncoder().encode(res.body),
      ...(res.trailers ? { trailers: res.trailers } : {}),
    };
  }
  // `fetch` has no way to read trailers, so a stream read here always fails safe.
  const res = await fetch(url, {
    method: "POST",
    headers,
    body: body as Uint8Array<ArrayBuffer>,
  });
  const out: Record<string, string> = {};
  res.headers.forEach((v, k) => {
    out[k] = v;
  });
  return { status: res.status, headers: out, body: new Uint8Array(await res.arrayBuffer()) };
}

/**
 * How the call ended: `"ok"` when a `grpc-status: 0` was seen in the headers
 * or trailers, `"missing"` when the trailers were readable and carried none
 * (the stream was cut off), `"unknown"` when the transport cannot read them.
 */
type CallEnd = "ok" | "missing" | "unknown";

/** Perform one call and return every message in the response body. */
async function call(
  ctx: ModalContext,
  method: string,
  request: Uint8Array,
): Promise<{ messages: Uint8Array[]; end: CallEnd }> {
  const res = await post(ctx, method, request);
  // Trailers-only errors put the status in the headers; everything else in a trailer.
  const source =
    header(res.headers, "grpc-status") !== undefined ? res.headers : (res.trailers ?? {});
  const status = header(source, "grpc-status");
  if (status !== undefined && status !== "0") {
    throw new ModalApiError(
      method,
      Number(status),
      decodeGrpcMessage(header(source, "grpc-message")),
      res.status,
    );
  }
  if (res.status !== 200) {
    throw new ModalApiError(
      method,
      res.status === 401 ? GrpcCode.UNAUTHENTICATED : GrpcCode.UNAVAILABLE,
      `HTTP ${res.status}`,
      res.status,
    );
  }
  const type = header(res.headers, "content-type") ?? "";
  if (!type.startsWith("application/grpc")) {
    throw new ModalApiError(
      method,
      GrpcCode.UNKNOWN,
      `unexpected response type "${type || "none"}" (is a proxy in the way?)`,
      res.status,
    );
  }
  const messages = unframe(res.body, method);
  const end: CallEnd = status === "0" ? "ok" : res.trailers ? "missing" : "unknown";
  return { messages, end };
}

/** A unary RPC. A missing message is the empty message, as protobuf defines it. */
export async function unary(
  ctx: ModalContext,
  method: string,
  request: Uint8Array,
): Promise<Uint8Array> {
  const { messages } = await call(ctx, method, request);
  return messages[0] ?? new Uint8Array();
}

/**
 * A unary RPC whose answer a sync prunes against. A server that succeeds frames its
 * message even when it is empty, so no frame and no `grpc-status: 0` means the
 * answer is unconfirmed (no status at all, or a trailer this transport cannot
 * read), which may well be a failure.
 */
export async function unaryList(
  ctx: ModalContext,
  method: string,
  request: Uint8Array,
): Promise<Uint8Array> {
  const { messages, end } = await call(ctx, method, request);
  if (messages[0]) return messages[0];
  if (end === "ok") return new Uint8Array();
  throw new ListPageError({ vendor: "Modal", path: method, key: null, found: undefined });
}

/**
 * A server-streaming RPC, collected. Only a stream that closed with
 * `grpc-status: 0` is complete: one that broke at a frame boundary is well
 * framed too, so with no status to say otherwise this throws.
 */
export async function serverStream(
  ctx: ModalContext,
  method: string,
  request: Uint8Array,
): Promise<Uint8Array[]> {
  const { messages, end } = await call(ctx, method, request);
  if (end === "ok") return messages;
  throw new ModalApiError(
    method,
    GrpcCode.UNKNOWN,
    end === "missing"
      ? "the stream ended without a gRPC status, so it may have been cut off"
      : "this host cannot read response trailers, so whether the stream finished is unknown",
  );
}
