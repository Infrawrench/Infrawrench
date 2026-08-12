import type { IncomingMessage, ServerResponse } from "node:http";
import type { TLSSocket } from "node:tls";
import {
  createMcpHandler,
  isLegacyRequest,
  WebStandardStreamableHTTPServerTransport,
  type McpHandlerRequestOptions,
} from "@modelcontextprotocol/server";
import { toNodeHandler, type NodeIncomingMessageLike } from "@modelcontextprotocol/node";
import { applySecurityHeaders } from "../api/security-headers";
import { authenticateMcpRequest, buildWwwAuthenticate } from "./auth";
import { buildMcpServer } from "./server";
import { buildResourceMetadataUrl } from "./well-known";

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return await new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c instanceof Buffer ? c : Buffer.from(c)));
    req.on("end", () => {
      if (chunks.length === 0) {
        resolve(undefined);
        return;
      }
      const text = Buffer.concat(chunks).toString("utf8");
      try {
        resolve(JSON.parse(text));
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

function reqUrlString(req: IncomingMessage): string {
  const host = req.headers.host ?? "localhost";
  const xfProto = req.headers["x-forwarded-proto"];
  const headerProto = Array.isArray(xfProto) ? xfProto[0] : xfProto;
  const proto = headerProto ?? ((req.socket as Partial<TLSSocket>).encrypted ? "https" : "http");
  return `${proto}://${host}${req.url ?? "/"}`;
}

export async function handleMcpHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
  // `server.ts` routes /api/mcp at the Node HTTP level, ahead of the Hono
  // listener, so the `securityHeaders()` middleware never sees these responses.
  // Set them here — before the auth check, so the 401 and the malformed-body
  // 400 carry them too, not just the SDK handler's own writes.
  applySecurityHeaders(res);

  const auth = await authenticateMcpRequest(req.headers["authorization"] ?? null);

  if (!auth) {
    const resourceMetadataUrl = buildResourceMetadataUrl(reqUrlString(req));
    res.statusCode = 401;
    res.setHeader("WWW-Authenticate", buildWwwAuthenticate(resourceMetadataUrl));
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ error: "Unauthorized" }));
    return;
  }

  let body: unknown = undefined;
  if (req.method === "POST") {
    try {
      body = await readJsonBody(req);
    } catch {
      res.statusCode = 400;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: "Invalid JSON body" }));
      return;
    }
  }

  // Modern (2026-07-28) requests — the per-request `_meta` envelope, no
  // handshake — go to the SDK's stateless handler, which owns version
  // negotiation, `server/discover`, the SEP-2243 header checks, and the
  // envelope error answers. Everything is built fresh per request; there is
  // no session state to share, so a per-request handler is exactly as
  // stateless as the protocol itself.
  const modern = createMcpHandler(() => buildMcpServer(auth), { legacy: "reject" });

  // Legacy (2025-era `initialize`-handshake) requests bypass `modern`'s
  // built-in stateless fallback so they keep the v1 behaviour our docs
  // promise: plain JSON response bodies (`enableJsonResponse`) rather than
  // SSE-framed ones. Session operations (GET/DELETE) get the stateless
  // idiom's 405, as the SDK's own fallback answers them.
  const legacy = async (
    request: Request,
    options?: McpHandlerRequestOptions,
  ): Promise<Response> => {
    if (request.method.toUpperCase() !== "POST") {
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          error: { code: -32000, message: "Method not allowed." },
          id: null,
        }),
        { status: 405, headers: { "content-type": "application/json" } },
      );
    }
    const server = await buildMcpServer(auth);
    const transport = new WebStandardStreamableHTTPServerTransport({
      enableJsonResponse: true,
    });
    await server.connect(transport);
    try {
      // JSON mode: the response resolves complete, so teardown can follow
      // immediately — nothing streams after this returns.
      return await transport.handleRequest(request, options);
    } finally {
      void transport.close();
      void server.close();
    }
  };

  const composed = {
    fetch: async (request: Request, options?: McpHandlerRequestOptions): Promise<Response> =>
      (await isLegacyRequest(request, options?.parsedBody))
        ? legacy(request, options)
        : modern.fetch(request, options),
  };

  // The adapter's duck-typed request declares `method?: string` without
  // `| undefined`, which `exactOptionalPropertyTypes` rejects for Node's
  // IncomingMessage; the runtime shapes agree.
  await toNodeHandler(composed)(req as unknown as NodeIncomingMessageLike, res, body);
}
