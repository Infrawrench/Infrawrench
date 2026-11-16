import { describe, it, expect, vi } from "vitest";

// The CI tools as the MCP server lists them: real definitions, with the CI
// modules they call stubbed (they read Postgres and the CI proxy).
vi.mock("@infrawrench/server-core/ci/accounts", () => ({
  ciStatus: vi.fn(),
}));
vi.mock("@infrawrench/server-core/ci/access", () => ({ ciAccessOverview: vi.fn() }));
vi.mock("@infrawrench/server-core/ci/billing", () => ({ ciUsage: vi.fn() }));
vi.mock("@infrawrench/server-core/ci/runs", () => ({
  CiInputError: class extends Error {},
  approveRun: vi.fn(),
  cancelRun: vi.fn(),
  dispatchRun: vi.fn(),
  getRun: vi.fn(),
  listRuns: vi.fn(async () => []),
  openRunLogs: vi.fn(),
  rejectRun: vi.fn(),
  retryRun: vi.fn(),
  startManualRun: vi.fn(),
}));
vi.mock("@infrawrench/server-core/ci/schedules", () => ({ listCiRepositories: vi.fn() }));
vi.mock("@infrawrench/server-core/ci/values", () => ({ listCiValues: vi.fn() }));
vi.mock("@/services/audit", () => ({ logAudit: vi.fn() }));

vi.mock("@/tools/registry", async () => {
  const { ciTools } = await import("@/tools/ci");
  const { forProduct } = await import("@/tools/products");
  return { getToolRegistry: vi.fn(async () => forProduct("delivery", ciTools())) };
});
vi.mock("@infrawrench/server-core/trials/ceremony", () => ({
  resolveAgentCredential: vi.fn(async () => null),
  getClaimStatus: vi.fn(async () => null),
}));
vi.mock("@/auth/users", () => ({ hasMembership: vi.fn(), listUserOrganizations: vi.fn() }));
// The permission gate and app policy are covered in tools/__tests__/ci.test.ts.
vi.mock("@/tools/permissions", () => ({
  authorizeToolCall: vi.fn(async () => null),
  toolsOfferedTo: async (tools: unknown[]) => tools,
  runToolHandler: (
    tool: { handler: (i: unknown, a: unknown) => unknown },
    input: unknown,
    auth: unknown,
  ) => tool.handler(input, auth),
}));

const { buildMcpServer } = await import("@/mcp/server");
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

const READS = [
  "list_ci_repositories",
  "list_ci_pipelines",
  "list_ci_runs",
  "get_ci_run",
  "get_ci_job_log",
  "list_ci_values",
  "get_ci_access",
  "get_ci_usage",
];
const ACTIONS = [
  "start_ci_run",
  "retry_ci_run",
  "cancel_ci_run",
  "approve_ci_run",
  "reject_ci_run",
];

describe("the MCP server's CI tools", () => {
  it("lists every CI tool, reads as read-only and actions as destructive", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    const byName = new Map(tools.map((t) => [t.name, t]));
    for (const name of READS) {
      expect(byName.get(name)?.annotations, name).toMatchObject({ readOnlyHint: true });
    }
    for (const name of ACTIONS) {
      expect(byName.get(name)?.annotations, name).toMatchObject({
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: true,
      });
    }
    expect(byName.get("get_ci_job_log")?.inputSchema.required).toEqual(["runId", "jobId"]);
    expect(Object.keys(byName.get("list_ci_runs")?.inputSchema.properties ?? {})).toEqual(
      expect.arrayContaining(["repoFullName", "branch", "status", "event", "pullNumber", "before"]),
    );
  });

  it("calls a CI tool through the server", async () => {
    const client = await connect();
    const res = await client.callTool({ name: "list_ci_runs", arguments: { limit: 5 } });
    expect(res.isError).toBeFalsy();
    const payload = JSON.parse((res.content as Array<{ text: string }>)[0]!.text);
    expect(payload).toEqual({ runs: [], nextBefore: null });
  });
});
