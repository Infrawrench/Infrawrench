import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import { McpServer } from "@modelcontextprotocol/server";

const mockAuthenticate = vi.fn();
vi.mock("@/mcp/auth", () => ({
  authenticateMcpRequest: (...a: unknown[]) => mockAuthenticate(...a),
  buildWwwAuthenticate: (url: string) => `Bearer resource_metadata="${url}"`,
}));

// A real (empty) McpServer rather than a stub: the SDK transports drive the
// server over its protocol wiring, so a `{ connect, close }` fake would never
// produce a response. The org-scoped tool surface is covered by
// mcp-server.test.ts; here only the HTTP plumbing is under test.
const mockBuildMcpServer = vi.fn();
vi.mock("@/mcp/server", () => ({
  buildMcpServer: (...a: unknown[]) => mockBuildMcpServer(...a),
}));

vi.mock("@/mcp/well-known", () => ({
  buildResourceMetadataUrl: (u: string) => `${u}/.well-known/oauth-protected-resource`,
}));

const { handleMcpHttp } = await import("@/mcp/http-handler");

function makeReq(opts: {
  method?: string;
  authorization?: string | null;
  body?: string;
  url?: string;
  headers?: Record<string, string>;
}): EventEmitter & Record<string | symbol, unknown> {
  const req = new EventEmitter() as EventEmitter & Record<string | symbol, unknown>;
  req.method = opts.method ?? "GET";
  req.url = opts.url ?? "/api/mcp";
  req.headers = {
    host: "app.infrawrench.com",
    accept: "application/json, text/event-stream",
    "content-type": "application/json",
    ...(opts.authorization ? { authorization: opts.authorization } : {}),
    ...(opts.headers ?? {}),
  };
  req.socket = {};
  // The handler consumes the body itself (readJsonBody) before handing the
  // request to the SDK adapter, which then iterates the request for a body it
  // will never use (a pre-parsed body is passed alongside). Satisfy both: emit
  // the body on listener registration, and be an exhausted async iterable.
  req.on("newListener", (event) => {
    if (event !== "end") return;
    queueMicrotask(() => {
      if (opts.body !== undefined) req.emit("data", Buffer.from(opts.body));
      req.emit("end");
    });
  });
  req[Symbol.asyncIterator] = async function* () {};
  return req;
}

function makeRes() {
  const res = new EventEmitter() as EventEmitter & {
    statusCode?: number;
    headers: Record<string, string>;
    body?: string;
    setHeader: (k: string, v: string) => void;
    writeHead: (code: number, headers?: Record<string, string>) => unknown;
    write: (chunk: string | Uint8Array) => unknown;
    end: (b?: string | Uint8Array) => void;
  };
  res.headers = {};
  res.setHeader = (k, v) => {
    res.headers[k.toLowerCase()] = v;
  };
  res.writeHead = (code, headers) => {
    res.statusCode = code;
    for (const [k, v] of Object.entries(headers ?? {})) res.headers[k.toLowerCase()] = v;
    return res;
  };
  const decode = (chunk: string | Uint8Array) =>
    typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
  res.write = (chunk) => {
    res.body = (res.body ?? "") + decode(chunk);
    return true;
  };
  res.end = (b) => {
    if (b !== undefined) res.body = (res.body ?? "") + decode(b);
    res.emit("finish");
  };
  return res;
}

describe("handleMcpHttp", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockBuildMcpServer.mockImplementation(
      async () => new McpServer({ name: "test", version: "0.0.0" }),
    );
  });

  it("returns 401 with a WWW-Authenticate header when unauthenticated", async () => {
    mockAuthenticate.mockResolvedValue(null);
    const req = makeReq({ authorization: null });
    const res = makeRes();
    await handleMcpHttp(req as never, res as never);
    expect(res.statusCode).toBe(401);
    expect(res.headers["www-authenticate"]).toContain("resource_metadata=");
    expect(mockBuildMcpServer).not.toHaveBeenCalled();
  });

  it("returns 400 on a POST with invalid JSON", async () => {
    mockAuthenticate.mockResolvedValue({ userId: "u1", organizationId: "org-1" });
    const req = makeReq({ method: "POST", authorization: "Bearer t", body: "{not json" });
    const res = makeRes();
    await handleMcpHttp(req as never, res as never);
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain("Invalid JSON body");
  });

  it("serves a legacy (2025-era) request with a plain JSON response", async () => {
    const auth = { userId: "u1", organizationId: "org-1" };
    mockAuthenticate.mockResolvedValue(auth);

    const req = makeReq({
      method: "POST",
      authorization: "Bearer t",
      body: JSON.stringify({ jsonrpc: "2.0", method: "ping", id: 1 }),
    });
    const res = makeRes();
    await handleMcpHttp(req as never, res as never);

    expect(mockBuildMcpServer).toHaveBeenCalledWith(auth);
    expect(res.statusCode).toBe(200);
    // enableJsonResponse: the body is the JSON-RPC result itself, not an SSE
    // frame — the behaviour hand-rolled clients depend on.
    expect(res.headers["content-type"]).toContain("application/json");
    const parsed = JSON.parse(res.body ?? "");
    expect(parsed).toMatchObject({ jsonrpc: "2.0", id: 1, result: {} });
  });

  it("answers a modern (2026-07-28) server/discover probe", async () => {
    const auth = { userId: "u1", organizationId: "org-1" };
    mockAuthenticate.mockResolvedValue(auth);

    const req = makeReq({
      method: "POST",
      authorization: "Bearer t",
      headers: {
        "mcp-protocol-version": "2026-07-28",
        "mcp-method": "server/discover",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "server/discover",
        params: {
          _meta: {
            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            "io.modelcontextprotocol/clientCapabilities": {},
          },
        },
      }),
    });
    const res = makeRes();
    await handleMcpHttp(req as never, res as never);

    expect(res.statusCode).toBe(200);
    const parsed = JSON.parse(res.body ?? "");
    expect(parsed.result.supportedVersions).toContain("2026-07-28");
    // 2026-era responses carry the server identity in _meta, not the body.
    expect(parsed.result._meta["io.modelcontextprotocol/serverInfo"]).toMatchObject({
      name: "test",
    });
  });

  /*
   * `server.ts` answers /api/mcp at the Node HTTP level in both dev and prod,
   * ahead of the Hono listener — so the `securityHeaders()` middleware never
   * sees these responses and the handler has to set them itself. Both server
   * modes call this one function, so covering it here covers both.
   */
  describe("security headers", () => {
    it("sets them on the 401", async () => {
      mockAuthenticate.mockResolvedValue(null);
      const res = makeRes();
      await handleMcpHttp(makeReq({ authorization: null }) as never, res as never);
      expect(res.statusCode).toBe(401);
      expect(res.headers["content-security-policy"]).toBe("frame-ancestors 'none'");
      expect(res.headers["x-frame-options"]).toBe("DENY");
      expect(res.headers["x-content-type-options"]).toBe("nosniff");
      // The 401 still has to carry its own auth-discovery header.
      expect(res.headers["www-authenticate"]).toContain("resource_metadata=");
    });

    it("sets them on the malformed-body 400", async () => {
      mockAuthenticate.mockResolvedValue({ userId: "u1", organizationId: "org-1" });
      const res = makeRes();
      const req = makeReq({ method: "POST", authorization: "Bearer t", body: "{not json" });
      await handleMcpHttp(req as never, res as never);
      expect(res.statusCode).toBe(400);
      expect(res.headers["x-frame-options"]).toBe("DENY");
    });

    it("sets them on SDK-served responses", async () => {
      // applySecurityHeaders runs before the SDK adapter ever touches the
      // response, so they ride along on whatever the transport writes.
      mockAuthenticate.mockResolvedValue({ userId: "u1", organizationId: "org-1" });
      const res = makeRes();
      const req = makeReq({
        method: "POST",
        authorization: "Bearer t",
        body: JSON.stringify({ jsonrpc: "2.0", method: "ping", id: 1 }),
      });
      await handleMcpHttp(req as never, res as never);
      expect(res.statusCode).toBe(200);
      expect(res.headers["content-security-policy"]).toBe("frame-ancestors 'none'");
      expect(res.headers["x-frame-options"]).toBe("DENY");
    });
  });
});
