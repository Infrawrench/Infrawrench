import type { ModalContext } from "../grpc.js";
import { ProtoMessage, ProtoWriter } from "../proto.js";

export interface Recorded {
  method: string;
  url: string;
  headers: Record<string, string>;
  request: ProtoMessage;
}

export type Reply =
  | ProtoWriter
  | ProtoWriter[]
  | { grpcStatus: number; message?: string }
  | { httpStatus: number; contentType?: string };

/** Length-prefix messages the way a gRPC response body carries them. */
export function framed(messages: Uint8Array[]): Uint8Array {
  const total = messages.reduce((n, m) => n + 5 + m.length, 0);
  const out = new Uint8Array(total);
  let pos = 0;
  for (const m of messages) {
    new DataView(out.buffer).setUint32(pos + 1, m.length, false);
    out.set(m, pos + 5);
    pos += 5 + m.length;
  }
  return out;
}

/**
 * A fake host HTTP service that answers gRPC calls by method name, so the
 * plugin's requests (path, headers, protobuf body) run end to end offline.
 */
export function makeHttp(route: (method: string, request: ProtoMessage) => Reply) {
  const calls: Recorded[] = [];
  const http = {
    async request(req: {
      url: string;
      method: string;
      headers: Record<string, string>;
      body?: string | Uint8Array;
      responseEncoding?: "utf8" | "binary";
    }) {
      const method = req.url.split("/").pop() ?? "";
      const body = req.body instanceof Uint8Array ? req.body : new Uint8Array();
      const request = new ProtoMessage(body.subarray(5));
      calls.push({ method, url: req.url, headers: req.headers, request });
      const reply = route(method, request);
      if ("grpcStatus" in reply) {
        return {
          status: 200,
          headers: {
            "content-type": "application/grpc",
            "grpc-status": String(reply.grpcStatus),
            "grpc-message": encodeURIComponent(reply.message ?? ""),
          },
          body: "",
          rawBody: new Uint8Array(),
        };
      }
      if ("httpStatus" in reply) {
        return {
          status: reply.httpStatus,
          headers: { "content-type": reply.contentType ?? "text/html" },
          body: "",
          rawBody: new Uint8Array(),
        };
      }
      const messages = (Array.isArray(reply) ? reply : [reply]).map((w) => w.finish());
      return {
        status: 200,
        headers: { "content-type": "application/grpc" },
        body: "",
        rawBody: framed(messages),
      };
    },
  };
  return { http, calls };
}

export function ctxWith(http: ReturnType<typeof makeHttp>["http"]): ModalContext {
  return { tokenId: "ak-test", tokenSecret: "as-test", serverUrl: "https://api.modal.com", http };
}

/** `map<string,string>` entries. */
export function withMap(w: ProtoWriter, field: number, map: Record<string, string>): ProtoWriter {
  for (const [k, v] of Object.entries(map)) {
    w.message(field, new ProtoWriter().string(1, k).string(2, v));
  }
  return w;
}

export function ts(ms: number): ProtoWriter {
  return new ProtoWriter().int(1, Math.floor(ms / 1000));
}
