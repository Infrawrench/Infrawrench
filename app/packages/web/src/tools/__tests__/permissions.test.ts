import { describe, it, expect, vi, beforeEach } from "vitest";

// The registry import reaches db/client and the WorkOS client, both of which
// throw at import time without these. No connection is opened.
process.env["DATABASE_URL"] ??= "postgres://test:test@localhost:5432/test";
process.env["ENCRYPTION_MASTER_KEY"] ??= Buffer.alloc(32, 1).toString("base64");
process.env["WORKOS_API_KEY"] ??= "test_workos_api_key";
process.env["WORKOS_CLIENT_ID"] ??= "test_workos_client_id";

const mockResolvePerms = vi.fn();
vi.mock("@infrawrench/server-core/permissions", () => ({
  resolveEffectivePermissions: (...a: unknown[]) => mockResolvePerms(...a),
}));

const { authorizeToolCall, denyUnlessPermitted, effectiveToolPermissions } =
  await import("../permissions");
const { getToolRegistry } = await import("../registry");
const { needsApproval } = await import("../approval");

const auth = { userId: "u1", organizationId: "o1", source: "mcp" as const };

function grant(...permissions: string[]) {
  mockResolvePerms.mockResolvedValue({ permissions, role: null });
}

describe("effectiveToolPermissions", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns the role's permissions for a session principal", async () => {
    grant("resources:read", "costs:read");
    expect(await effectiveToolPermissions(auth)).toEqual(["resources:read", "costs:read"]);
  });

  it("intersects an API key's scopes with the owner's role", async () => {
    grant("*");
    const keyAuth = { ...auth, scopes: ["resources:read"] };
    expect(await effectiveToolPermissions(keyAuth)).toEqual(["resources:read"]);
  });

  it("takes an agent's permissions as final, without consulting its user row", async () => {
    // The `users` row an agent acts as is a plain `member` on purpose (so the
    // last-owner guard and seat accounting read it as "not a person, not an
    // owner"). Intersecting with that role would silently narrow every agent
    // to member-level and deny over MCP what the same `iwa_` credential is
    // granted over HTTP.
    grant("resources:read");
    const agentAuth = {
      ...auth,
      agentRegistrationId: "reg-1",
      scopes: ["resources:read", "resources:write", "accounts:write"],
    };
    expect(await effectiveToolPermissions(agentAuth)).toEqual([
      "resources:read",
      "resources:write",
      "accounts:write",
    ]);
    expect(mockResolvePerms).not.toHaveBeenCalled();
  });

  it("does not let a broad key exceed a downgraded owner role", async () => {
    grant("resources:read");
    const keyAuth = { ...auth, scopes: ["*"] };
    expect(await effectiveToolPermissions(keyAuth)).toEqual(["resources:read"]);
  });

  it("expands wildcards on both sides when intersecting", async () => {
    grant("*");
    const keyAuth = { ...auth, scopes: ["budgets:*"] };
    expect(await effectiveToolPermissions(keyAuth)).toEqual(["budgets:read", "budgets:write"]);
  });

  it("grants nothing to a key with an empty scope list", async () => {
    grant("*");
    expect(await effectiveToolPermissions({ ...auth, scopes: [] })).toEqual([]);
  });

  it("re-reads on every call so a mid-turn role change takes effect", async () => {
    grant("resources:read");
    expect(await denyUnlessPermitted(auth, "resources:read")).toBeNull();
    grant();
    expect(await denyUnlessPermitted(auth, "resources:read")).not.toBeNull();
  });
});

describe("authorizeToolCall", () => {
  beforeEach(() => vi.clearAllMocks());

  it("allows a tool that declares no permission without consulting the role", async () => {
    expect(await authorizeToolCall({ permission: null }, auth)).toBeNull();
    expect(mockResolvePerms).not.toHaveBeenCalled();
  });

  it("denies when the declared permission is missing", async () => {
    grant("resources:read");
    const denied = await authorizeToolCall({ permission: "resources:delete" }, auth);
    expect(denied?.isError).toBe(true);
    expect(denied?.content[0]?.text).toContain("resources:delete");
  });

  it("honours wildcard grants", async () => {
    grant("resources:*");
    expect(await authorizeToolCall({ permission: "resources:delete" }, auth)).toBeNull();
  });
});

describe("tool registry permission declarations", () => {
  it("declares a permission on every registered tool", async () => {
    // `permission` is required by the type, but the value can still be wrong.
    // This asserts the field was considered rather than left off a new tool.
    const tools = await getToolRegistry();
    expect(tools.length).toBeGreaterThan(0);
    for (const tool of tools) {
      expect(tool, `${tool.name} must declare a permission`).toHaveProperty("permission");
      if (tool.permission !== null) {
        expect(typeof tool.permission, `${tool.name} permission must be a string`).toBe("string");
      }
    }
  });

  it("never leaves a write or destructive tool ungated", async () => {
    const tools = await getToolRegistry();
    const mutating = tools.filter((t) => t.risk === "write" || t.risk === "destructive");
    expect(mutating.length).toBeGreaterThan(0);
    for (const tool of mutating) {
      expect(
        tool.permission,
        `${tool.name} is ${tool.risk} and must not be ungated`,
      ).not.toBeNull();
    }
  });

  /**
   * The permissions that must match the equivalent HTTP route, spelled out
   * rather than inferred. `risk` and `permission` are separate axes: a tool can
   * be `destructive` (confirm in the chat UI) while needing only a read
   * permission, because revealing a secret is disclosure, not mutation.
   */
  it.each([
    ["delete_resource", "resources:delete"],
    ["create_resource", "resources:write"],
    ["apply_manifest", "resources:write"],
    ["invoke_action", "resources:write"],
    ["ssh_exec", "resources:execute"],
    ["sql_execute", "resources:execute"],
    ["docker_command", "resources:execute"],
    ["kv_command", "resources:execute"],
    ["add_secret_version", "secrets:write"],
    ["modify_secret_version", "secrets:write"],
    ["access_secret_version", "secrets:read"],
    ["export_credential", "secrets:read"],
    ["delete_storage_object", "storage:write"],
    ["make_storage_folder", "storage:write"],
    ["delete_ssh_key", "ssh-keys:write"],
    ["trust_ssh_host", "accounts:write"],
    ["delete_budget", "budgets:write"],
    // Business metrics are cost data, not budgets: reads are costs:read and
    // writes costs:write, matching saved filters and the cost push endpoint.
    ["list_business_metrics", "costs:read"],
    ["query_unit_costs", "costs:read"],
    ["list_business_metric_labels", "costs:read"],
    ["list_usage_units", "costs:read"],
    ["create_business_metric", "costs:write"],
    ["write_business_metric_values", "costs:write"],
    ["delete_business_metric", "costs:write"],
    // Importers run a query with an account's credentials, so configuring,
    // previewing and running one is gated on the query monitors' permission
    // (the handler also checks costs:write).
    ["list_business_metric_sources", "costs:read"],
    ["get_business_metric_importer", "costs:read"],
    ["list_business_metric_source_options", "resources:execute"],
    ["preview_business_metric_import", "resources:execute"],
    ["set_business_metric_importer", "resources:execute"],
    ["run_business_metric_importer", "resources:execute"],
    ["delete_business_metric_importer", "costs:write"],
    // Invoices are their own family, not `costs:*`: a managed account holds a
    // customer's contact details and the price that customer was quoted, which
    // is commercial information about a third party rather than the org's own
    // spend. Every invoice tool is read-only: approving and sending are acts a
    // person takes, with their name on the audit entry.
    ["list_managed_accounts", "invoices:read"],
    ["get_managed_account", "invoices:read"],
    ["list_invoices", "invoices:read"],
    ["get_invoice", "invoices:read"],
    // A dry run: reads spend, writes nothing. Naming a customer also needs
    // invoices:read, checked in the handler.
    ["preview_billing_rule", "costs:read"],
    ["write_custom_graph", "dashboards:write"],
    ["delete_custom_graph", "dashboards:write"],
    // Workflows have their own family now: custom graphs above deliberately
    // stay on `dashboards:*` because they really are dashboard content.
    ["list_workflows", "workflows:read"],
    ["get_workflow", "workflows:read"],
    ["get_workflow_typings", "workflows:read"],
    ["check_workflow_source", "workflows:read"],
    ["list_workflow_secrets", "secrets:read"],
    ["write_workflow_secret", "secrets:write"],
    ["delete_workflow_secret", "secrets:write"],
    ["write_workflow", "workflows:write"],
    ["run_workflow", "workflows:write"],
    ["delete_workflow", "workflows:write"],
  ])("gates %s behind %s", async (name, permission) => {
    const tools = await getToolRegistry();
    expect(tools.find((t) => t.name === name)?.permission).toBe(permission);
  });

  it("leaves no workflow tool on the dashboards permissions", async () => {
    const tools = await getToolRegistry();
    const workflowTools = tools.filter((t) => t.name.includes("workflow"));
    expect(workflowTools.length).toBeGreaterThan(0);
    for (const tool of workflowTools) {
      expect(tool.permission, tool.name).not.toMatch(/^dashboards:/);
    }
  });

  it("gates every per-plugin create tool behind resources:write", async () => {
    const tools = await getToolRegistry();
    const creates = tools.filter((t) => /^[a-z0-9]+_create_/.test(t.name));
    expect(creates.length).toBeGreaterThan(0);
    for (const tool of creates) {
      expect(tool.permission, tool.name).toBe("resources:write");
    }
  });
});

/**
 * Chat auto-runs anything `needsApproval` says no to. These are the
 * calls that execute code, rotate credentials, or arm unattended state
 * changes, and so must stop at the approval card like `ssh_exec` does.
 */
describe("chat approval gating", () => {
  const target = { resourceId: "r1", windowId: 1 };
  it.each<[string, Record<string, unknown>, boolean]>([
    ["ssh_exec", { command: "uptime" }, true],
    ["launch_app", { ...target, exec: "xterm" }, true],
    ["launch_app", { ...target, appId: "org.gnome.Calculator" }, false],
    ["launch_app", { ...target, appId: "org.gnome.Calculator", exec: "  " }, false],
    ["type_in_app_window", { ...target, text: "ls" }, true],
    ["press_keys_in_app_window", { ...target, keys: "Enter" }, true],
    ["click_app_window", { ...target, x: 1, y: 1 }, false],
    ["add_secret_version", { value: "v" }, true],
    ["create_schedule", { resourceId: "r1" }, true],
    ["write_workflow", { name: "new" }, false],
    ["write_workflow", { workflowId: "w1", description: "d", enabled: false }, false],
    ["write_workflow", { source: "infra.log(1)" }, true],
    ["write_workflow", { workflowId: "w1", trigger: { kind: "cron", cron: "* * * * *" } }, true],
    ["write_workflow", { workflowId: "w1", enabled: true }, true],
    ["write_workflow", { workflowId: "w1", secretIds: ["s1"] }, true],
    ["run_workflow", { workflowId: "w1" }, true],
    ["write_custom_graph", { graphId: "g1", name: "renamed" }, false],
    ["write_custom_graph", { source: "graph.render({})" }, true],
    ["write_cost_canvas", { name: "New canvas", spec: { version: 1, blocks: [] } }, false],
    ["delete_cost_canvas", { canvasId: "c1" }, true],
  ])("%s %j needs approval: %s", async (name, input, expected) => {
    const tool = (await getToolRegistry()).find((t) => t.name === name);
    expect(tool, name).toBeDefined();
    expect(await needsApproval(tool!, input, { ...auth, source: "chat" })).toBe(expected);
  });

  it("never puts a per-call approval hook on a destructive tool", async () => {
    // A destructive tool always needs approval, so the hook would be dead
    // code that reads as if some calls skip the card.
    for (const tool of await getToolRegistry()) {
      if (tool.requiresApproval) expect(tool.risk, tool.name).not.toBe("destructive");
    }
  });
});
