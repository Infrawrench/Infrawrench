/*
 * End-to-end protocol-era coverage: real MCP SDK clients driving the handler
 * over an actual HTTP socket. The modern client is the v2 SDK (2026-07-28,
 * per-request envelope, no handshake); the legacy client is the v1 SDK
 * (2025-era `initialize` handshake), loaded out of the pnpm store where it
 * survives as a transitive dependency — the point being that clients written
 * before the 2026-07-28 revision keep working against the migrated endpoint.
 */
import { it, expect, vi, afterAll } from "vitest";
import http from "node:http";
import { readdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { McpServer, fromJsonSchema } from "@modelcontextprotocol/server";

vi.mock("@/mcp/auth", () => ({
  authenticateMcpRequest: async (h: string | null) =>
    h === "Bearer good" ? { userId: "u1", organizationId: "org-1" } : null,
  buildWwwAuthenticate: (url: string) => `Bearer resource_metadata="${url}"`,
}));
vi.mock("@/mcp/well-known", () => ({ buildResourceMetadataUrl: (u: string) => u }));
// A one-tool server instead of the real registry (which imports db/client and
// needs DATABASE_URL at import time). The `fromJsonSchema` input path is the
// same one buildMcpServer uses, so a client-side schema round-trip is covered.
vi.mock("@/mcp/server", () => ({
  buildMcpServer: async () => {
    const s = new McpServer({ name: "test", version: "0.0.0" });
    s.registerTool(
      "echo",
      {
        description: "echo",
        inputSchema: fromJsonSchema<Record<string, unknown>>({
          type: "object",
          properties: { msg: { type: "string" } },
          required: ["msg"],
        }),
      },
      async (input) => ({
        content: [{ type: "text" as const, text: `echo:${(input as { msg: string }).msg}` }],
      }),
    );
    return s;
  },
}));

const { handleMcpHttp } = await import("@/mcp/http-handler");
const server = http.createServer((req, res) => void handleMcpHttp(req, res));
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const port = (server.address() as { port: number }).port;
const url = new URL(`http://127.0.0.1:${port}/api/mcp`);
afterAll(() => new Promise((r) => server.close(r)));

it("serves a modern (2026-07-28) v2 client end-to-end", async () => {
  const { Client, StreamableHTTPClientTransport } = await import("@modelcontextprotocol/client");
  const client = new Client({ name: "e2e-v2", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: { headers: { Authorization: "Bearer good" } },
  });
  await client.connect(transport);
  const { tools } = await client.listTools();
  expect(tools.map((t) => t.name)).toContain("echo");
  const res = await client.callTool({ name: "echo", arguments: { msg: "hi" } });
  expect((res.content as Array<{ text: string }>)[0]!.text).toBe("echo:hi");
  await client.close();
});

/** The v1 SDK is only in the tree as someone else's transitive dependency. */
function findV1Sdk(): string | null {
  const store = path.resolve(__dirname, "../../../../../../node_modules/.pnpm");
  const dir = readdirSync(store).find((d) => d.startsWith("@modelcontextprotocol+sdk@1."));
  return dir ? path.join(store, dir, "node_modules/@modelcontextprotocol/sdk") : null;
}

it.skipIf(findV1Sdk() === null)("serves a legacy (2025-era) v1 client end-to-end", async () => {
  const req = createRequire(import.meta.url);
  const v1 = findV1Sdk()!;
  const { Client } = req(path.join(v1, "dist/cjs/client/index.js"));
  const { StreamableHTTPClientTransport } = req(path.join(v1, "dist/cjs/client/streamableHttp.js"));
  const client = new Client({ name: "e2e-v1", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: { headers: { Authorization: "Bearer good" } },
  });
  await client.connect(transport);
  const { tools } = await client.listTools();
  expect(tools.map((t: { name: string }) => t.name)).toContain("echo");
  const res = await client.callTool({ name: "echo", arguments: { msg: "old" } });
  expect(res.content[0].text).toBe("echo:old");
  await client.close();
});
