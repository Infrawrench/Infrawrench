import { describe, it, expect, vi, beforeEach } from "vitest";
import { z } from "zod";

const handler = vi.fn(async (_input: Record<string, unknown>, _auth: unknown) => ({
  content: [{ type: "text" as const, text: "done" }],
}));

vi.mock("@infrawrench/server-core/trials/ceremony", () => ({
  resolveAgentCredential: vi.fn(async () => null),
  getClaimStatus: vi.fn(async () => null),
}));

vi.mock("@/tools/registry", () => ({
  getToolRegistry: vi.fn(async () => [
    {
      name: "list_resources",
      title: "List resources",
      description: "Lists resources.",
      inputSchema: { limit: z.number().optional() },
      risk: "read" as const,
      permission: "resources:read",
      handler,
    },
  ]),
}));

vi.mock("@/api/auth-middleware", () => ({
  hasMembership: vi.fn(),
  listUserOrganizations: vi.fn(),
}));

// Not the real module: it reaches the permissions resolver, which imports
// db/client and needs DATABASE_URL at import time.
const mockAuthorizeToolCall = vi.fn();
vi.mock("@/tools/permissions", () => ({
  authorizeToolCall: (...a: unknown[]) => mockAuthorizeToolCall(...a),
}));

const { buildMcpServer } = await import("@/mcp/server");
const middleware = await import("@/api/auth-middleware");
const { Client, InMemoryTransport } = await import("@modelcontextprotocol/client");

async function connect() {
  const server = await buildMcpServer({ userId: "user_1", organizationId: "org_default" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1.0.0" });
  await Promise.all([
    server.connect(serverTransport as never),
    client.connect(clientTransport as never),
  ]);
  return client;
}

describe("MCP server org scoping", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Authorized unless a test says otherwise.
    mockAuthorizeToolCall.mockResolvedValue(null);
  });

  it("exposes an optional org_id on every registry tool", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    const listResources = tools.find((t) => t.name === "list_resources");

    expect(listResources?.inputSchema.properties).toHaveProperty("org_id");
    // Optional — a caller that omits it still gets the default org.
    expect(listResources?.inputSchema.required ?? []).not.toContain("org_id");
  });

  it("registers list_organizations and marks the default org", async () => {
    vi.mocked(middleware.listUserOrganizations).mockResolvedValue([
      { id: "org_default", displayName: "Acme", role: "owner" },
      { id: "org_other", displayName: "Beta", role: "member" },
    ]);

    const client = await connect();
    const res = await client.callTool({ name: "list_organizations", arguments: {} });
    const payload = JSON.parse((res.content as Array<{ text: string }>)[0]!.text);

    expect(payload).toEqual([
      { org_id: "org_default", name: "Acme", role: "owner", default: true },
      { org_id: "org_other", name: "Beta", role: "member", default: false },
    ]);
  });

  it("runs against the default org when org_id is omitted", async () => {
    const client = await connect();
    await client.callTool({ name: "list_resources", arguments: { limit: 5 } });

    expect(handler).toHaveBeenCalledWith(
      { limit: 5 },
      expect.objectContaining({
        organizationId: "org_default",
        source: "mcp",
      }),
    );
    // org_id must not leak through to the tool's own handler.
    expect(handler.mock.calls[0]![0]).not.toHaveProperty("org_id");
  });

  it("overrides the org when org_id names another of the caller's orgs", async () => {
    vi.mocked(middleware.hasMembership).mockResolvedValue(true);

    const client = await connect();
    await client.callTool({
      name: "list_resources",
      arguments: { limit: 1, org_id: "org_other" },
    });

    expect(middleware.hasMembership).toHaveBeenCalledWith("user_1", "org_other");
    expect(handler).toHaveBeenCalledWith(
      { limit: 1 },
      expect.objectContaining({ organizationId: "org_other" }),
    );
  });

  it("refuses an org the caller is not a member of, without running the tool", async () => {
    vi.mocked(middleware.hasMembership).mockResolvedValue(false);

    const client = await connect();
    const res = await client.callTool({
      name: "list_resources",
      arguments: { org_id: "org_someone_else" },
    });

    expect(res.isError).toBe(true);
    expect((res.content as Array<{ text: string }>)[0]!.text).toContain("not a member");
    expect(handler).not.toHaveBeenCalled();
  });

  it("checks the tool's permission against the org the call resolved to", async () => {
    vi.mocked(middleware.hasMembership).mockResolvedValue(true);

    const client = await connect();
    await client.callTool({ name: "list_resources", arguments: { org_id: "org_other" } });

    // Not the default org: an MCP client that switches orgs mid-session must be
    // re-authorized against the org it actually named.
    expect(mockAuthorizeToolCall).toHaveBeenCalledWith(
      expect.objectContaining({ permission: "resources:read" }),
      expect.objectContaining({ userId: "user_1", organizationId: "org_other" }),
    );
  });

  it("refuses a tool the caller lacks the permission for, without running it", async () => {
    mockAuthorizeToolCall.mockResolvedValue({
      content: [{ type: "text", text: "Missing permission: resources:read" }],
      isError: true,
    });

    const client = await connect();
    const res = await client.callTool({ name: "list_resources", arguments: {} });

    expect(res.isError).toBe(true);
    expect((res.content as Array<{ text: string }>)[0]!.text).toContain(
      "Missing permission: resources:read",
    );
    expect(handler).not.toHaveBeenCalled();
  });
});
