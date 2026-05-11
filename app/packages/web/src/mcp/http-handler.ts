import type { IncomingMessage, ServerResponse } from "node:http";
import type { TLSSocket } from "node:tls";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
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

  const server = await buildMcpServer(auth);

  // Stateless mode: a fresh transport per request, no session cookie. Omit
  // sessionIdGenerator entirely (rather than passing `undefined`) because the
  // SDK's options type uses `?: () => string` which `exactOptionalPropertyTypes`
  // forbids passing `undefined` to.
  const transport = new StreamableHTTPServerTransport({
    enableJsonResponse: true,
  });

  res.on("close", () => {
    void transport.close();
    void server.close();
  });

  // The SDK's StreamableHTTPServerTransport declares `onclose` looser than
  // the Transport interface; cast to satisfy server.connect().
  await server.connect(transport as unknown as Transport);
  await transport.handleRequest(req, res, body);
}
