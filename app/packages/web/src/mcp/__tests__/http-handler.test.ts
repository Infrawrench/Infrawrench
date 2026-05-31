import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";

const mockAuthenticate = vi.fn();
vi.mock("@/mcp/auth", () => ({
  authenticateMcpRequest: (...a: unknown[]) => mockAuthenticate(...a),
  buildWwwAuthenticate: (url: string) => `Bearer resource_metadata="${url}"`,
}));

const mockBuildMcpServer = vi.fn();
vi.mock("@/mcp/server", () => ({
  buildMcpServer: (...a: unknown[]) => mockBuildMcpServer(...a),
}));

vi.mock("@/mcp/well-known", () => ({
  buildResourceMetadataUrl: (u: string) => `${u}/.well-known/oauth-protected-resource`,
}));

const mockHandleRequest = vi.fn();
const mockTransportClose = vi.fn();
vi.mock("@modelcontextprotocol/sdk/server/streamableHttp.js", () => ({
  StreamableHTTPServerTransport: class {
    handleRequest = mockHandleRequest;
    close = mockTransportClose;
  },
}));

const { handleMcpHttp } = await import("@/mcp/http-handler");

function makeReq(opts: {
  method?: string;
  authorization?: string | null;
  body?: string;
  url?: string;
}): EventEmitter & Record<string, unknown> {
  const req = new EventEmitter() as EventEmitter & Record<string, unknown>;
  req.method = opts.method ?? "GET";
  req.url = opts.url ?? "/api/mcp";
  req.headers = {
    host: "app.infrawrench.com",
    ...(opts.authorization ? { authorization: opts.authorization } : {}),
  };
  req.socket = {};
  // Push the body once the handler attaches its "end" listener (it attaches
  // "data" and "end" together inside readJsonBody). Emitting on listener
  // registration avoids racing the handler's awaited auth step.
  req.on("newListener", (event) => {
    if (event !== "end") return;
    queueMicrotask(() => {
      if (opts.body !== undefined) req.emit("data", Buffer.from(opts.body));
      req.emit("end");
    });
  });
  return req;
}

function makeRes() {
  const res = new EventEmitter() as EventEmitter & {
    statusCode?: number;
    headers: Record<string, string>;
    body?: string;
    setHeader: (k: string, v: string) => void;
    end: (b?: string) => void;
  };
  res.headers = {};
  res.setHeader = (k, v) => {
    res.headers[k.toLowerCase()] = v;
  };
  res.end = (b) => {
    res.body = b;
  };
  return res;
}

describe("handleMcpHttp", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockBuildMcpServer.mockResolvedValue({ connect: vi.fn(), close: vi.fn() });
    mockHandleRequest.mockResolvedValue(undefined);
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

  it("connects the server and handles a valid POST request", async () => {
    const auth = { userId: "u1", organizationId: "org-1" };
    mockAuthenticate.mockResolvedValue(auth);
    const connect = vi.fn().mockResolvedValue(undefined);
    mockBuildMcpServer.mockResolvedValue({ connect, close: vi.fn() });

    const req = makeReq({
      method: "POST",
      authorization: "Bearer t",
      body: JSON.stringify({ jsonrpc: "2.0", method: "ping", id: 1 }),
    });
    const res = makeRes();
    await handleMcpHttp(req as never, res as never);

    expect(mockBuildMcpServer).toHaveBeenCalledWith(auth);
    expect(connect).toHaveBeenCalled();
    expect(mockHandleRequest).toHaveBeenCalledWith(req, res, {
      jsonrpc: "2.0",
      method: "ping",
      id: 1,
    });
  });
});
