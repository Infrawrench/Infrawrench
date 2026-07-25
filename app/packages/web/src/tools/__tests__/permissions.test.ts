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
  ])("gates %s behind %s", async (name, permission) => {
    const tools = await getToolRegistry();
    expect(tools.find((t) => t.name === name)?.permission).toBe(permission);
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
