import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("../invoke", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

import {
  applyCloudManifest,
  cloudListSshKeys,
  cloudTunnelSshAttach,
  createCloudResource,
  deleteCloudResource,
  exportCloudCredential,
  fetchCloudMetrics,
  fetchCloudPeerPanes,
  getCloudCreateConfig,
  getCloudCreateCostEstimate,
  getCloudCreatePricing,
  getCloudDescribe,
  getCloudLogs,
  getCloudManifest,
  getCloudResourceDetail,
  importCloudYaml,
  invokeCloudAction,
  loadCloudPickerResources,
  runCloudNoSqlCommand,
  updateCloudResource,
} from "../cloud-resources";

beforeEach(() => {
  invoke.mockReset();
  invoke.mockResolvedValue(undefined);
});

describe("cloud-resources conditional arg-spreading", () => {
  it("getCloudResourceDetail omits includePeerPanes when not given", async () => {
    await getCloudResourceDetail("org1", "p", "t", "r", "acc");
    expect(invoke).toHaveBeenCalledWith("cloud_get_resource_detail", {
      orgId: "org1",
      pluginId: "p",
      resourceTypeId: "t",
      resourceId: "r",
      accountId: "acc",
      parentResourceId: undefined,
    });
  });

  it("getCloudResourceDetail includes includePeerPanes when given", async () => {
    await getCloudResourceDetail("org1", "p", "t", "r", "acc", "parent", {
      includePeerPanes: true,
    });
    const call = invoke.mock.calls[0]![1] as Record<string, unknown>;
    expect(call.includePeerPanes).toBe(true);
    expect(call.parentResourceId).toBe("parent");
  });

  it("getCloudCreatePricing omits regionId when absent", async () => {
    invoke.mockResolvedValue({});
    await getCloudCreatePricing("org1", "acc", "t", { sizes: [] });
    const call = invoke.mock.calls[0]![1] as Record<string, unknown>;
    expect(call).not.toHaveProperty("regionId");
    expect(call.sizes).toEqual([]);
  });

  it("getCloudCreatePricing includes regionId when present", async () => {
    invoke.mockResolvedValue({});
    await getCloudCreatePricing("org1", "acc", "t", { regionId: "us", sizes: [] });
    const call = invoke.mock.calls[0]![1] as Record<string, unknown>;
    expect(call.regionId).toBe("us");
  });

  it("getCloudLogs spreads params", async () => {
    invoke.mockResolvedValue({ text: "", containers: [], activeContainer: "" });
    await getCloudLogs("org1", "p", "t", "r", "acc", { tailLines: 50, container: "main" });
    const call = invoke.mock.calls[0]![1] as Record<string, unknown>;
    expect(call.tailLines).toBe(50);
    expect(call.container).toBe("main");
  });

  it("loadCloudPickerResources omits optional opts", async () => {
    invoke.mockResolvedValue([]);
    await loadCloudPickerResources("org1", [], "acc");
    const call = invoke.mock.calls[0]![1] as Record<string, unknown>;
    expect(call).not.toHaveProperty("regionHint");
    expect(call).not.toHaveProperty("crossAccount");
  });

  it("loadCloudPickerResources includes regionHint and crossAccount", async () => {
    invoke.mockResolvedValue([]);
    await loadCloudPickerResources("org1", [], "acc", { regionHint: "eu", crossAccount: true });
    const call = invoke.mock.calls[0]![1] as Record<string, unknown>;
    expect(call.regionHint).toBe("eu");
    expect(call.crossAccount).toBe(true);
  });

  it("runCloudNoSqlCommand unwraps .result", async () => {
    invoke.mockResolvedValue({ result: { rows: 3 } });
    const body = {
      pluginId: "p",
      accountId: "acc",
      resourceTypeId: "t",
      resourceId: "r",
      command: "find",
      args: [],
    };
    const res = await runCloudNoSqlCommand("org1", body);
    expect(invoke).toHaveBeenCalledWith("cloud_nosql_command", { orgId: "org1", body });
    expect(res).toEqual({ rows: 3 });
  });
});

describe("cloud-resources straightforward wrappers", () => {
  it("createCloudResource", async () => {
    invoke.mockResolvedValue({ id: "x", displayName: "X" });
    const body = { accountId: "a", pluginId: "p", resourceTypeId: "t", fields: {} };
    await createCloudResource("org1", body);
    expect(invoke).toHaveBeenCalledWith("cloud_create_resource", { orgId: "org1", body });
  });

  it("updateCloudResource", async () => {
    invoke.mockResolvedValue({ id: "x", displayName: "X", fields: {} });
    const body = {
      accountId: "a",
      pluginId: "p",
      resourceTypeId: "t",
      resourceId: "r",
      fields: {},
    };
    await updateCloudResource("org1", body);
    expect(invoke).toHaveBeenCalledWith("cloud_update_resource", { orgId: "org1", body });
  });

  it("cloudTunnelSshAttach", async () => {
    invoke.mockResolvedValue({ steps: [] });
    const body = {
      tunnel: { accountId: "a", pluginId: "p", resourceId: "r" },
      host: { accountId: "a2", pluginId: "p2", resourceTypeId: "t", resourceId: "r2" },
      hostname: "h",
      zoneId: "z",
      sshUsername: "u",
    };
    await cloudTunnelSshAttach("org1", body);
    expect(invoke).toHaveBeenCalledWith("cloud_tunnel_ssh_attach", { orgId: "org1", body });
  });

  it("cloudListSshKeys", async () => {
    invoke.mockResolvedValue([]);
    await cloudListSshKeys("org1");
    expect(invoke).toHaveBeenCalledWith("cloud_list_ssh_keys", { orgId: "org1" });
  });

  it("getCloudCreateConfig", async () => {
    await getCloudCreateConfig("org1", "acc", "t", "p", "parent");
    expect(invoke).toHaveBeenCalledWith("cloud_get_create_config", {
      orgId: "org1",
      accountId: "acc",
      resourceTypeId: "t",
      pluginId: "p",
      parentResourceId: "parent",
    });
  });

  it("getCloudCreateCostEstimate", async () => {
    invoke.mockResolvedValue({ estimate: {} });
    await getCloudCreateCostEstimate("org1", "acc", "t", { f: "v" });
    expect(invoke).toHaveBeenCalledWith("cloud_get_create_cost_estimate", {
      orgId: "org1",
      accountId: "acc",
      resourceTypeId: "t",
      fields: { f: "v" },
      pluginId: undefined,
      parentResourceId: undefined,
    });
  });

  it("deleteCloudResource", async () => {
    await deleteCloudResource("org1", "p", "t", "r", "acc");
    expect(invoke).toHaveBeenCalledWith("cloud_delete_resource", {
      orgId: "org1",
      pluginId: "p",
      resourceTypeId: "t",
      resourceId: "r",
      accountId: "acc",
      parentResourceId: undefined,
    });
  });

  it("exportCloudCredential", async () => {
    await exportCloudCredential("org1", "p", "t", "r", "acc", "fmt");
    expect(invoke).toHaveBeenCalledWith(
      "cloud_export_credential",
      expect.objectContaining({ formatId: "fmt" }),
    );
  });

  it("getCloudManifest", async () => {
    invoke.mockResolvedValue({ manifest: "yaml" });
    await getCloudManifest("org1", "p", "t", "r", "acc");
    expect(invoke).toHaveBeenCalledWith("cloud_get_manifest", expect.any(Object));
  });

  it("applyCloudManifest", async () => {
    const body = { accountId: "a", resourceId: "r", manifest: "y" };
    await applyCloudManifest("org1", "p", "t", body);
    expect(invoke).toHaveBeenCalledWith("cloud_apply_manifest", {
      orgId: "org1",
      pluginId: "p",
      resourceTypeId: "t",
      body,
    });
  });

  it("invokeCloudAction", async () => {
    const body = {
      pluginId: "p",
      accountId: "a",
      resourceTypeId: "t",
      resourceId: "r",
      actionId: "act",
    };
    await invokeCloudAction("org1", body);
    expect(invoke).toHaveBeenCalledWith("cloud_invoke_action", { orgId: "org1", body });
  });

  it("importCloudYaml", async () => {
    invoke.mockResolvedValue({ applied: 2 });
    const body = { accountId: "a", yaml: "y" };
    await importCloudYaml("org1", "p", body);
    expect(invoke).toHaveBeenCalledWith("cloud_import_yaml", {
      orgId: "org1",
      pluginId: "p",
      body,
    });
  });

  it("getCloudDescribe", async () => {
    invoke.mockResolvedValue({ text: "" });
    await getCloudDescribe("org1", "p", "t", "r", "acc");
    expect(invoke).toHaveBeenCalledWith("cloud_describe_resource", expect.any(Object));
  });

  it("fetchCloudMetrics", async () => {
    const body = { accountId: "a", resourceId: "r" };
    await fetchCloudMetrics("org1", "p", "t", body);
    expect(invoke).toHaveBeenCalledWith("cloud_fetch_metrics", {
      orgId: "org1",
      pluginId: "p",
      resourceTypeId: "t",
      body,
    });
  });

  it("fetchCloudPeerPanes", async () => {
    const body = { accountId: "a", resourceId: "r" };
    await fetchCloudPeerPanes("org1", "p", "t", body);
    expect(invoke).toHaveBeenCalledWith("cloud_fetch_peer_panes", {
      orgId: "org1",
      pluginId: "p",
      resourceTypeId: "t",
      body,
    });
  });
});
