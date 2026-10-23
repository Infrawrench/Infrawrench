import { describe, it, expect, vi, beforeAll } from "vitest";
import { getTableName } from "drizzle-orm";

/**
 * Agent scopes binding on the tool layer (MCP and chat).
 *
 * An agent's permissions are final (`resolveAgentPrincipal`), and the MCP
 * server must hold every registry tool to them: a tool it lacks the permission
 * for is neither listed nor callable, and a provider-narrowed grant
 * (`resources:aws:read`) is honoured only for calls pinned to that provider.
 * These run over the real registry, so a tool added later is covered without
 * anyone remembering to add it here.
 */

process.env["DATABASE_URL"] ??= "postgres://test:test@localhost:5432/test";
process.env["ENCRYPTION_MASTER_KEY"] ??= Buffer.alloc(32, 1).toString("base64");
process.env["WORKOS_API_KEY"] ??= "test_workos_api_key";
process.env["WORKOS_CLIENT_ID"] ??= "test_workos_client_id";

vi.mock("@infrawrench/server-core/permissions", () => ({
  // Agents never reach the role resolver; reaching it would be the bug.
  resolveEffectivePermissions: vi.fn(async () => {
    throw new Error("an agent's permissions must not be re-resolved");
  }),
}));

// The plugin-scope lookups: accounts and synced resources of org "o1".
const ACCOUNTS = [
  { id: "acct-aws", organizationId: "o1", pluginId: "aws" },
  { id: "acct-gcp", organizationId: "o1", pluginId: "gcp" },
  { id: "acct-other-org", organizationId: "o2", pluginId: "aws" },
];
const RESOURCES = [
  { id: "res-aws", organizationId: "o1", pluginId: "aws" },
  { id: "res-gcp", organizationId: "o1", pluginId: "gcp" },
];
let lastIds: string[] = [];
vi.mock("@/db/client", () => ({
  db: {
    select: () => ({
      from: (table: unknown) => ({
        where: async () => {
          const name = getTableName(table as never);
          const rows = name === "accounts" ? ACCOUNTS : name === "resources" ? RESOURCES : [];
          return rows.filter((r) => r.organizationId === "o1" && lastIds.includes(r.id));
        },
      }),
    }),
  },
}));

const { authorizeToolCall, toolUsableWith } = await import("../permissions");
const { getToolRegistry } = await import("../registry");
const { isProviderScoped } = await import("@infrawrench/server-core/agent-links/scopes");

beforeAll(async () => {
  await getToolRegistry();
}, 120_000);

function agent(...permissions: string[]) {
  return {
    userId: "agent_reg-1",
    organizationId: "o1",
    source: "mcp" as const,
    agentRegistrationId: "reg-1",
    scopes: permissions,
  };
}

async function call(name: string, input: Record<string, unknown>, permissions: string[]) {
  const tool = (await getToolRegistry()).find((t) => t.name === name);
  if (!tool) throw new Error(`no tool ${name}`);
  lastIds = Object.values(input).filter((v): v is string => typeof v === "string");
  return await authorizeToolCall(tool, agent(...permissions), input);
}

describe("every registry tool binds to an agent's permissions", () => {
  it("an agent with no permissions can list or call only ungated tools", async () => {
    for (const tool of await getToolRegistry()) {
      const usable = toolUsableWith(tool, []);
      expect(usable, tool.name).toBe(tool.permission === null);
      lastIds = [];
      const denied = await authorizeToolCall(tool, agent(), {});
      expect(denied === null, tool.name).toBe(tool.permission === null);
    }
  });

  it("an agent holding exactly a tool's permission may list and call it", async () => {
    for (const tool of await getToolRegistry()) {
      if (tool.permission === null) continue;
      expect(toolUsableWith(tool, [tool.permission]), tool.name).toBe(true);
      lastIds = [];
      expect(await authorizeToolCall(tool, agent(tool.permission), {}), tool.name).toBeNull();
    }
  });

  it("holding one permission never unlocks a tool gated on another", async () => {
    const tools = await getToolRegistry();
    for (const tool of tools) {
      if (tool.permission === null || tool.permission === "costs:read") continue;
      expect(toolUsableWith(tool, ["costs:read"]), tool.name).toBe(false);
    }
  });
});

describe("provider-narrowed grants", () => {
  const AWS_READ = ["resources:aws:read"];

  it("are listed only on tools that can name a provider", async () => {
    for (const tool of await getToolRegistry()) {
      if (tool.permission !== "resources:read") continue;
      const usable = toolUsableWith(tool, AWS_READ);
      const names = Object.keys(tool.inputSchema);
      const canName = [
        "pluginId",
        "pluginIds",
        "sourcePluginId",
        "referencePluginId",
        "accountId",
        "sourceAccountId",
        "resourceId",
        "parentResourceId",
        "sourceResourceId",
        "targetResourceId",
      ].some((k) => names.includes(k));
      if (!canName && !tool.pluginId) expect(usable, tool.name).toBe(false);
    }
  });

  it("allow a call pinned to the allowed provider", async () => {
    expect(
      await call(
        "list_resources",
        { pluginId: "aws", accountId: "acct-aws", resourceTypeId: "ec2-instance" },
        AWS_READ,
      ),
    ).toBeNull();
  });

  it("refuse a call to another provider", async () => {
    const denied = await call(
      "list_resources",
      { pluginId: "gcp", accountId: "acct-gcp", resourceTypeId: "gce-instance" },
      AWS_READ,
    );
    expect(denied?.isError).toBe(true);
    expect(denied?.content[0]?.text).toContain("gcp");
  });

  it("refuse a call that claims the allowed plugin but names another provider's account", async () => {
    const denied = await call(
      "list_resources",
      { pluginId: "aws", accountId: "acct-gcp", resourceTypeId: "ec2-instance" },
      AWS_READ,
    );
    expect(denied?.isError).toBe(true);
  });

  it("refuse an account from another organization", async () => {
    const denied = await call(
      "list_resources",
      { pluginId: "aws", accountId: "acct-other-org", resourceTypeId: "ec2-instance" },
      AWS_READ,
    );
    expect(denied?.isError).toBe(true);
  });

  it("resolve a synced resource's provider from its id", async () => {
    expect(await call("get_resource_inputs", { resourceId: "res-aws" }, AWS_READ)).toBeNull();
    expect((await call("get_resource_inputs", { resourceId: "res-gcp" }, AWS_READ))?.isError).toBe(
      true,
    );
  });

  it("refuse a call that names no provider at all", async () => {
    const denied = await call("get_resource_inputs", { resourceId: "unknown" }, AWS_READ);
    expect(denied?.isError).toBe(true);
  });

  it("do not stretch to another verb", async () => {
    const denied = await call(
      "delete_resource",
      { pluginId: "aws", accountId: "acct-aws", resourceTypeId: "x", resourceId: "y" },
      AWS_READ,
    );
    expect(denied?.isError).toBe(true);
  });

  it("bind the fixed-plugin create tools to their plugin", async () => {
    const tools = await getToolRegistry();
    const fixed = tools.filter((t) => t.pluginId && t.permission === "resources:write");
    expect(fixed.length).toBeGreaterThan(0);
    for (const tool of fixed) {
      expect(toolUsableWith(tool, ["resources:aws:write"]), tool.name).toBe(
        tool.pluginId === "aws",
      );
    }
  });

  it("lists what a narrowed agent would see (audit aid)", async () => {
    if (!process.env["PRINT_NARROWED_TOOLS"]) return;
    for (const tool of await getToolRegistry()) {
      if (tool.pluginId || tool.permission === null || !isProviderScoped(tool.permission)) continue;
      const [family, verb] = tool.permission.split(":");
      if (toolUsableWith(tool, [`${family}:aws:${verb}`])) {
        console.log(
          "NARROWED",
          tool.name,
          tool.permission,
          Object.keys(tool.inputSchema).join(","),
        );
      }
    }
  });

  it("never unlock a tool that reaches beyond the providers it names", async () => {
    for (const name of ["get_blast_radius", "ssh_exec"]) {
      const tool = (await getToolRegistry()).find((t) => t.name === name)!;
      const [family, verb] = tool.permission!.split(":");
      expect(toolUsableWith(tool, [`${family}:aws:${verb}`]), name).toBe(false);
    }
    const denied = await call("get_blast_radius", { resourceId: "res-aws" }, [
      "resources:aws:read",
    ]);
    expect(denied?.isError).toBe(true);
  });

  it("only ever apply to provider-scoped families", async () => {
    for (const tool of await getToolRegistry()) {
      if (tool.permission === null || isProviderScoped(tool.permission)) continue;
      expect(toolUsableWith(tool, ["resources:aws:read"]), tool.name).toBe(false);
    }
  });
});
