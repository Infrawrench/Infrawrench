import { describe, it, expect, vi, beforeEach } from "vitest";

const mockSelect = vi.fn();
const mockInsert = vi.fn();
vi.mock("../../db/client", () => ({
  db: {
    select: (...a: unknown[]) => mockSelect(...a),
    insert: (...a: unknown[]) => mockInsert(...a),
  },
}));
vi.mock("../../db/schema", () => ({
  accounts: {
    id: "id",
    organizationId: "org",
    deletedAt: "del",
    pluginId: "pid",
    displayName: "dn",
    createdAt: "ts",
  },
  resources: {
    id: "id",
    organizationId: "org",
    deletedAt: "del",
    pluginId: "pid",
    resourceTypeId: "rt",
    accountId: "aid",
    displayName: "dn",
  },
  secretFieldStates: { resourceId: "rid", fieldKey: "fk" },
}));

const mockLoadPlugins = vi.fn();
const mockGetPlugin = vi.fn();
vi.mock("../../plugins/loader", () => ({
  loadPlugins: (...a: unknown[]) => mockLoadPlugins(...a),
  getPlugin: (...a: unknown[]) => mockGetPlugin(...a),
}));

const mockGetClientForAccount = vi.fn();
const mockGetClientForResource = vi.fn();
vi.mock("../../services/plugin-clients", () => ({
  getClientForAccount: (...a: unknown[]) => mockGetClientForAccount(...a),
  getClientForResource: (...a: unknown[]) => mockGetClientForResource(...a),
}));

vi.mock("../../services/encryption", () => ({
  encrypt: vi.fn().mockResolvedValue({ ciphertext: "ct", iv: "iv" }),
  buildAad: vi.fn().mockReturnValue("aad"),
}));
vi.mock("../../services/audit", () => ({ logAudit: vi.fn() }));
vi.mock("@infrawrench/plugin-base", () => ({
  normalizeResourceCreateResult: (r: unknown) => ({ resource: r, warnings: [] }),
}));
vi.mock("uuid", () => ({ v4: () => "sfs-uuid" }));

const { genericTools } = await import("../generic");
const tools = genericTools();
const tool = (name: string) => tools.find((t) => t.name === name)!;
const auth = { userId: "u1", organizationId: "o1", source: "chat" as const };

describe("genericTools", () => {
  beforeEach(() => vi.clearAllMocks());

  it("list_plugins returns flattened manifest metadata", async () => {
    mockLoadPlugins.mockResolvedValue([
      {
        plugin: {
          manifest: {
            id: "aws",
            displayName: "AWS",
            description: "Amazon",
            credentialFields: [{ key: "k", label: "K", sensitive: true }],
          },
        },
      },
    ]);
    const r = await tool("list_plugins").handler({}, auth);
    const out = JSON.parse(r.content[0]!.text);
    expect(out[0].id).toBe("aws");
    expect(out[0].credentialFields[0].sensitive).toBe(true);
  });

  it("list_resource_types errors for unknown plugin", async () => {
    mockGetPlugin.mockResolvedValue(null);
    const r = await tool("list_resource_types").handler({ pluginId: "ghost" }, auth);
    expect(r.isError).toBe(true);
  });

  it("list_resource_types maps capability flags", async () => {
    mockGetPlugin.mockResolvedValue({
      plugin: {
        resourceTypes: [
          {
            id: "ec2",
            displayName: "EC2",
            pluralDisplayName: "EC2s",
            description: "d",
            supportsCreate: true,
            supportsDelete: false,
            supportsMetrics: true,
            fields: [{ key: "name", label: "Name", kind: "string", required: true }],
            outputs: [{ key: "ip", label: "IP", sensitive: false }],
          },
        ],
      },
    });
    const r = await tool("list_resource_types").handler({ pluginId: "aws" }, auth);
    const out = JSON.parse(r.content[0]!.text);
    expect(out[0].supportsCreate).toBe(true);
    expect(out[0].supportsDelete).toBe(false);
    expect(out[0].supportsMetrics).toBe(true);
  });

  it("list_accounts queries the org's accounts", async () => {
    const where = vi.fn().mockResolvedValue([{ id: "a1", pluginId: "aws", displayName: "Prod" }]);
    const from = vi.fn().mockReturnValue({ where });
    mockSelect.mockReturnValue({ from });
    const r = await tool("list_accounts").handler({}, auth);
    const out = JSON.parse(r.content[0]!.text);
    expect(out[0].id).toBe("a1");
  });

  it("search_resources matches by substring", async () => {
    const where1 = vi.fn().mockResolvedValue([
      {
        id: "r1",
        pluginId: "aws",
        resourceTypeId: "ec2",
        accountId: "a1",
        displayName: "prod-web",
      },
    ]);
    const from1 = vi.fn().mockReturnValue({ where: where1 });
    const where2 = vi.fn().mockResolvedValue([{ id: "a1", displayName: "Prod", pluginId: "aws" }]);
    const from2 = vi.fn().mockReturnValue({ where: where2 });
    mockSelect.mockReturnValueOnce({ from: from1 }).mockReturnValueOnce({ from: from2 });
    mockGetPlugin.mockResolvedValue({
      plugin: {
        manifest: { displayName: "AWS" },
        resourceTypes: [{ id: "ec2", displayName: "EC2" }],
      },
    });
    const r = await tool("search_resources").handler({ query: "prod" }, auth);
    const out = JSON.parse(r.content[0]!.text);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe("r1");
  });

  it("get_resource errors when context not found", async () => {
    mockGetClientForResource.mockResolvedValue(null);
    const r = await tool("get_resource").handler(
      { pluginId: "aws", accountId: "a1", resourceTypeId: "rt", resourceId: "r1" },
      auth,
    );
    expect(r.isError).toBe(true);
  });

  it("get_resource returns the instance", async () => {
    mockGetClientForResource.mockResolvedValue({
      client: {
        getResource: vi.fn().mockResolvedValue({
          id: "r1",
          displayName: "web",
          resourceTypeId: "rt",
          pluginId: "aws",
          accountId: "a1",
          fields: {},
          resolvedOutputs: {},
        }),
      },
    });
    const r = await tool("get_resource").handler(
      { pluginId: "aws", accountId: "a1", resourceTypeId: "rt", resourceId: "r1" },
      auth,
    );
    expect(JSON.parse(r.content[0]!.text).id).toBe("r1");
  });

  it("get_resource_outputs resolves each key and captures per-key errors", async () => {
    mockGetClientForResource.mockResolvedValue({
      client: {
        resolveOutput: vi
          .fn()
          .mockResolvedValueOnce("1.2.3.4")
          .mockRejectedValueOnce(new Error("no perms")),
      },
      plugin: {
        resourceTypes: [{ id: "rt", outputs: [{ key: "ipv4" }, { key: "secret" }] }],
      },
    });
    const r = await tool("get_resource_outputs").handler(
      { pluginId: "aws", accountId: "a1", resourceTypeId: "rt", resourceId: "r1" },
      auth,
    );
    const out = JSON.parse(r.content[0]!.text);
    expect(out.ipv4).toBe("1.2.3.4");
    expect(out.secret.error).toBe("no perms");
  });

  it("create_resource errors when plugin lacks createResource", async () => {
    mockGetClientForResource.mockResolvedValue({ client: {}, account: { pluginId: "aws" } });
    const r = await tool("create_resource").handler(
      { pluginId: "aws", accountId: "a1", resourceTypeId: "rt", fields: {} },
      auth,
    );
    expect(r.isError).toBe(true);
  });

  it("create_resource persists and returns id", async () => {
    const onConflictDoUpdate = vi.fn().mockResolvedValue(undefined);
    const values = vi.fn().mockReturnValue({ onConflictDoUpdate });
    mockInsert.mockReturnValue({ values });
    mockGetClientForResource.mockResolvedValue({
      client: {
        createResource: vi.fn().mockResolvedValue({
          id: "new-r",
          displayName: "new",
          fields: {},
          resolvedOutputs: {},
          secretStates: [],
        }),
      },
      account: { pluginId: "aws" },
    });
    const r = await tool("create_resource").handler(
      { pluginId: "aws", accountId: "a1", resourceTypeId: "rt", fields: { name: "x" } },
      auth,
    );
    const out = JSON.parse(r.content[0]!.text);
    expect(out.id).toBe("new-r");
    expect(values).toHaveBeenCalled();
  });

  it("delete_resource errors when unsupported", async () => {
    mockGetClientForResource.mockResolvedValue({ client: {} });
    const r = await tool("delete_resource").handler(
      { pluginId: "aws", accountId: "a1", resourceTypeId: "rt", resourceId: "r1" },
      auth,
    );
    expect(r.isError).toBe(true);
  });

  it("delete_resource succeeds", async () => {
    mockGetClientForResource.mockResolvedValue({
      client: { deleteResource: vi.fn().mockResolvedValue(undefined) },
    });
    const r = await tool("delete_resource").handler(
      { pluginId: "aws", accountId: "a1", resourceTypeId: "rt", resourceId: "r1" },
      auth,
    );
    expect(JSON.parse(r.content[0]!.text).ok).toBe(true);
  });

  it("invoke_action runs the action", async () => {
    mockGetClientForResource.mockResolvedValue({
      client: { invokeAction: vi.fn().mockResolvedValue(undefined) },
    });
    const r = await tool("invoke_action").handler(
      {
        pluginId: "aws",
        accountId: "a1",
        resourceTypeId: "rt",
        resourceId: "r1",
        actionId: "start",
      },
      auth,
    );
    expect(JSON.parse(r.content[0]!.text).ok).toBe(true);
  });

  it("get_resource_stats errors when not supported", async () => {
    mockGetClientForResource.mockResolvedValue({ client: {} });
    const r = await tool("get_resource_stats").handler(
      { pluginId: "aws", accountId: "a1", resourceTypeId: "rt", resourceId: "r1" },
      auth,
    );
    expect(r.isError).toBe(true);
  });

  it("apply_manifest errors when unsupported", async () => {
    mockGetClientForResource.mockResolvedValue({ client: {} });
    const r = await tool("apply_manifest").handler(
      { pluginId: "k8s", accountId: "a1", resourceTypeId: "rt", resourceId: "r1", manifest: "x" },
      auth,
    );
    expect(r.isError).toBe(true);
  });

  it("attach_resource validates account/plugin mismatch", async () => {
    mockGetClientForAccount.mockResolvedValue({ client: {}, account: { pluginId: "gcp" } });
    const r = await tool("attach_resource").handler(
      {
        pluginId: "aws",
        accountId: "a1",
        sourceTypeId: "disk",
        sourceResourceId: "d1",
        targetTypeId: "vm",
        targetResourceId: "v1",
      },
      auth,
    );
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toMatch(/mismatch/);
  });
});
