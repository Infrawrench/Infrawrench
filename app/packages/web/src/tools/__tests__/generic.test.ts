import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockSelect, mockInsert, mockDb, mockSchema, mockEncryption } = vi.hoisted(() => {
  const select = vi.fn();
  const insert = vi.fn();
  return {
    mockSelect: select,
    mockInsert: insert,
    mockDb: () => ({ db: { select, insert } }),
    mockSchema: () => ({
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
        fieldsJson: "fields",
      },
      secretFieldStates: { resourceId: "rid", fieldKey: "fk" },
    }),
    mockEncryption: () => ({
      encrypt: vi.fn().mockResolvedValue({ ciphertext: "ct", iv: "iv" }),
      buildAad: vi.fn().mockReturnValue("aad"),
    }),
  };
});
vi.mock("../../db/client", mockDb);
vi.mock("../../db/schema", mockSchema);
// The create path writes through server-core's shared upsert helpers, which
// reach for server-core's own copies of these modules — the web re-export
// shims aren't on that import path, so both spellings need the same stubs.
vi.mock("@infrawrench/server-core/db/client", mockDb);
vi.mock("@infrawrench/server-core/db/schema", mockSchema);
vi.mock("@infrawrench/server-core/encryption", mockEncryption);

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
  // Pass-through: gating logic is covered by the service's own tests.
  filterVisiblePeerIntegrations: (integrations: unknown[]) => integrations,
}));

vi.mock("../../services/encryption", mockEncryption);
vi.mock("../../services/audit", () => ({ logAudit: vi.fn() }));
// No freeze in effect by default — the freeze gate has its own tests.
vi.mock("../../services/change-freezes", () => ({
  checkChangeFreezeForTool: vi.fn().mockResolvedValue(null),
  getActiveChangeFreeze: vi.fn().mockResolvedValue(null),
  isActionDestructive: vi.fn().mockResolvedValue(false),
}));
vi.mock("@infrawrench/plugin-base", () => ({
  normalizeResourceCreateResult: (r: unknown) => ({ resource: r, warnings: [] }),
  evaluatePeerIntegrationUnreachable: () => null,
}));
// The status correlation and expiry feed modules load the whole plugin
// registry (and, transitively, the db client) at import time — stub them;
// both have their own server-core tests.
vi.mock("@infrawrench/server-core/status/match", () => ({
  getOrgStatusIncidents: vi.fn().mockResolvedValue([]),
}));
const mockListExpiring = vi.fn();
vi.mock("@infrawrench/server-core/expiry/feed", () => ({
  listExpiring: (...a: unknown[]) => mockListExpiring(...a),
}));

const mockListPosture = vi.fn();
vi.mock("@infrawrench/server-core/posture/feed", () => ({
  listPosture: (...a: unknown[]) => mockListPosture(...a),
}));

const mockDismissPosture = vi.fn();
const mockRestorePosture = vi.fn();
vi.mock("@infrawrench/server-core/posture/dismissals", () => ({
  dismissPostureFinding: (...a: unknown[]) => mockDismissPosture(...a),
  restorePostureFinding: (...a: unknown[]) => mockRestorePosture(...a),
}));
const mockResolveSshKey = vi.fn();
vi.mock("../ssh-key-lookup", () => ({
  resolveStoredSshPublicKey: (...a: unknown[]) => mockResolveSshKey(...a),
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

  it("list_posture_findings filters by severity but keeps whole-feed counts", async () => {
    const finding = (ruleId: string, severity: string, category: string) => ({
      resourceId: `r-${ruleId}`,
      pluginId: "aws",
      pluginName: "AWS",
      resourceTypeId: "bucket",
      resourceTypeName: "S3 Bucket",
      accountId: "a1",
      accountName: "Prod",
      displayName: "b",
      externalId: null,
      ruleId,
      title: "t",
      severity,
      category,
      reason: "because",
    });
    mockListPosture.mockResolvedValue({
      findings: [
        finding("crit", "critical", "public-exposure"),
        finding("med", "medium", "encryption"),
      ],
      totalCount: 2,
      counts: { critical: 1, high: 0, medium: 1, low: 0 },
      generatedAt: "2026-08-01T00:00:00.000Z",
    });
    const r = await tool("list_posture_findings").handler({ severity: "critical" }, auth);
    const out = JSON.parse(r.content[0]!.text);
    expect(mockListPosture).toHaveBeenCalledWith("o1");
    expect(out.findings).toHaveLength(1);
    expect(out.findings[0].ruleId).toBe("crit");
    expect(out.matchedCount).toBe(1);
    // Counts describe the whole feed, not the filtered view.
    expect(out.totalCount).toBe(2);
    expect(out.counts).toEqual({ critical: 1, high: 0, medium: 1, low: 0 });
  });

  it("list_posture_findings filters by category", async () => {
    mockListPosture.mockResolvedValue({
      findings: [
        {
          resourceId: "r1",
          ruleId: "a",
          severity: "high",
          category: "encryption",
        },
        {
          resourceId: "r2",
          ruleId: "b",
          severity: "high",
          category: "public-exposure",
        },
      ],
      totalCount: 2,
      counts: { critical: 0, high: 2, medium: 0, low: 0 },
      generatedAt: "2026-08-01T00:00:00.000Z",
    });
    const r = await tool("list_posture_findings").handler({ category: "encryption" }, auth);
    const out = JSON.parse(r.content[0]!.text);
    expect(out.findings.map((f: { ruleId: string }) => f.ruleId)).toEqual(["a"]);
  });

  it("list_posture_findings reports the dismissed count and hides the rows by default", async () => {
    const dismissed = {
      resourceId: "r-public",
      ruleId: "public",
      severity: "critical",
      category: "public-exposure",
      dismissal: {
        resourceId: "r-public",
        ruleId: "public",
        dismissedAt: "2026-07-01T00:00:00.000Z",
        dismissedBy: "Ada",
        reason: "static site",
      },
    };
    const feed = {
      findings: [{ resourceId: "r1", ruleId: "a", severity: "high", category: "encryption" }],
      totalCount: 1,
      counts: { critical: 0, high: 1, medium: 0, low: 0 },
      dismissed: [dismissed],
      dismissedCount: 1,
      generatedAt: "2026-08-01T00:00:00.000Z",
    };

    mockListPosture.mockResolvedValue(feed);
    const quiet = JSON.parse(
      (await tool("list_posture_findings").handler({}, auth)).content[0]!.text,
    );
    // The count is always there — "clean" must be distinguishable from
    // "quiet because somebody silenced it" — but the rows are opt-in.
    expect(quiet.dismissedCount).toBe(1);
    expect(quiet.dismissed).toBeUndefined();
    expect(quiet.findings).toHaveLength(1);

    mockListPosture.mockResolvedValue(feed);
    const loud = JSON.parse(
      (await tool("list_posture_findings").handler({ includeDismissed: true }, auth)).content[0]!
        .text,
    );
    expect(loud.dismissed).toHaveLength(1);
    expect(loud.dismissed[0].dismissal.reason).toBe("static site");
    // A filter applies to the dismissed rows too.
    mockListPosture.mockResolvedValue(feed);
    const filtered = JSON.parse(
      (
        await tool("list_posture_findings").handler(
          { includeDismissed: true, category: "encryption" },
          auth,
        )
      ).content[0]!.text,
    );
    expect(filtered.dismissed).toEqual([]);
  });

  it("dismiss_posture_finding records the acceptance with its author", async () => {
    mockDismissPosture.mockResolvedValue({
      resourceId: "r1",
      ruleId: "public",
      reason: "static site",
      dismissedBy: "Ada",
      dismissedAt: "2026-08-01T00:00:00.000Z",
    });
    const r = await tool("dismiss_posture_finding").handler(
      { resourceId: "r1", ruleId: "public", reason: "static site" },
      auth,
    );
    expect(mockDismissPosture).toHaveBeenCalledWith("o1", {
      resourceId: "r1",
      ruleId: "public",
      reason: "static site",
      userId: "u1",
    });
    expect(JSON.parse(r.content[0]!.text).dismissed.ruleId).toBe("public");
  });

  it("restore_posture_finding says so when nothing was dismissed", async () => {
    mockRestorePosture.mockResolvedValue(false);
    const missing = await tool("restore_posture_finding").handler(
      { resourceId: "r1", ruleId: "public" },
      auth,
    );
    expect(missing.isError).toBe(true);

    mockRestorePosture.mockResolvedValue(true);
    const r = await tool("restore_posture_finding").handler(
      { resourceId: "r1", ruleId: "public" },
      auth,
    );
    expect(r.isError).toBeUndefined();
    expect(JSON.parse(r.content[0]!.text).restored).toEqual({ resourceId: "r1", ruleId: "public" });
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

  it("list_resource_sidecars surfaces peer integrations with the peer's resource types", async () => {
    // DOKS-style cluster: the account plugin's type declares a kubernetes peer.
    mockGetClientForAccount.mockResolvedValue({
      account: { id: "a1", pluginId: "digitalocean" },
      plugin: {
        resourceTypes: [
          {
            id: "doks-cluster",
            displayName: "Kubernetes Cluster",
            peerIntegrations: [
              { pluginId: "kubernetes", tabLabel: "Kubernetes", credentialMappings: [] },
            ],
          },
        ],
      },
      client: {
        getResource: vi.fn().mockResolvedValue({ id: "c1", fields: { region: "nyc1" } }),
      },
    });
    // Synced row resolves the parent's type without probing.
    const limit = vi.fn().mockResolvedValue([{ resourceTypeId: "doks-cluster", fieldsJson: {} }]);
    const where = vi.fn().mockReturnValue({ limit });
    const from = vi.fn().mockReturnValue({ where });
    mockSelect.mockReturnValue({ from });
    mockGetPlugin.mockResolvedValue({
      plugin: {
        manifest: { id: "kubernetes", displayName: "Kubernetes" },
        resourceTypes: [
          { id: "k8s-deployment", displayName: "Deployment", supportsCreate: true },
          { id: "k8s-pod", displayName: "Pod" },
        ],
      },
    });

    const r = await tool("list_resource_sidecars").handler(
      { accountId: "a1", resourceId: "c1" },
      auth,
    );
    expect(r.isError).toBeUndefined();
    const out = JSON.parse(r.content[0]!.text) as {
      sidecars: Array<{ pluginId: string; resourceTypes: Array<{ id: string }> }>;
      usage: string;
    };
    expect(out.sidecars).toHaveLength(1);
    expect(out.sidecars[0]!.pluginId).toBe("kubernetes");
    expect(out.sidecars[0]!.resourceTypes.map((t) => t.id)).toEqual(["k8s-deployment", "k8s-pod"]);
    expect(out.usage).toContain('parentResourceId: "c1"');
  });

  it("create_resource resolves sshKeyId into the type's SSH-key field", async () => {
    const createResource = vi.fn().mockResolvedValue({ id: "d1", displayName: "vm-1" });
    mockGetClientForResource.mockResolvedValue({
      account: { id: "a1", pluginId: "digitalocean" },
      plugin: {
        resourceTypes: [{ id: "droplet", agentVm: { sshKeyFieldKey: "sshPublicKey" } }],
      },
      client: { createResource },
    });
    mockResolveSshKey.mockResolvedValue("ssh-ed25519 AAAA-resolved deploy");
    const values = vi.fn().mockReturnValue({ onConflictDoUpdate: vi.fn().mockResolvedValue([]) });
    mockInsert.mockReturnValue({ values });

    const r = await tool("create_resource").handler(
      {
        pluginId: "digitalocean",
        accountId: "a1",
        resourceTypeId: "droplet",
        fields: { name: "vm-1", region: "nyc3" },
        sshKeyId: "key-1",
      },
      auth,
    );
    expect(r.isError).toBeUndefined();
    expect(mockResolveSshKey).toHaveBeenCalledWith("o1", "key-1");
    expect(createResource).toHaveBeenCalledWith(
      "droplet",
      "a1",
      { name: "vm-1", region: "nyc3", sshPublicKey: "ssh-ed25519 AAAA-resolved deploy" },
      undefined,
    );
  });

  it("create_resource rejects sshKeyId on types that take no SSH key", async () => {
    const createResource = vi.fn();
    mockGetClientForResource.mockResolvedValue({
      account: { id: "a1", pluginId: "digitalocean" },
      plugin: { resourceTypes: [{ id: "volume" }] },
      client: { createResource },
    });

    const r = await tool("create_resource").handler(
      {
        pluginId: "digitalocean",
        accountId: "a1",
        resourceTypeId: "volume",
        fields: { name: "v1" },
        sshKeyId: "key-1",
      },
      auth,
    );
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toMatch(/does not accept an SSH key/);
    expect(createResource).not.toHaveBeenCalled();
  });

  it("list_resource_sidecars reports when a type has no sidecars", async () => {
    mockGetClientForAccount.mockResolvedValue({
      account: { id: "a1", pluginId: "digitalocean" },
      plugin: { resourceTypes: [{ id: "droplet", displayName: "Droplet" }] },
      client: { getResource: vi.fn().mockResolvedValue({ id: "d1", fields: {} }) },
    });
    const r = await tool("list_resource_sidecars").handler(
      { accountId: "a1", resourceId: "d1", resourceTypeId: "droplet" },
      auth,
    );
    expect(r.isError).toBeUndefined();
    const out = JSON.parse(r.content[0]!.text) as { sidecars: unknown[] };
    expect(out.sidecars).toEqual([]);
  });
});
