import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("../invoke", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

import {
  createCloudDashboard,
  deleteCloudDashboard,
  getCloudDashboard,
  getCloudEnrichedPin,
  listCloudDashboards,
  pinCloudResource,
  probeCloudPins,
  renameCloudDashboard,
  reorderCloudCards,
  unpinCloudResource,
} from "../cloud-dashboards";

beforeEach(() => {
  invoke.mockReset();
  invoke.mockResolvedValue(undefined);
});

describe("cloud-dashboards wrappers", () => {
  it("listCloudDashboards", async () => {
    await listCloudDashboards("org1");
    expect(invoke).toHaveBeenCalledWith("cloud_list_dashboards", { orgId: "org1" });
  });

  it("getCloudDashboard", async () => {
    await getCloudDashboard("org1", "d1");
    expect(invoke).toHaveBeenCalledWith("cloud_get_dashboard", {
      orgId: "org1",
      dashboardId: "d1",
    });
  });

  it("createCloudDashboard", async () => {
    await createCloudDashboard("org1", "Home");
    expect(invoke).toHaveBeenCalledWith("cloud_create_dashboard", { orgId: "org1", name: "Home" });
  });

  it("deleteCloudDashboard", async () => {
    await deleteCloudDashboard("org1", "d1");
    expect(invoke).toHaveBeenCalledWith("cloud_delete_dashboard", { orgId: "org1", id: "d1" });
  });

  it("renameCloudDashboard", async () => {
    await renameCloudDashboard("org1", "d1", "New");
    expect(invoke).toHaveBeenCalledWith("cloud_rename_dashboard", {
      orgId: "org1",
      id: "d1",
      name: "New",
    });
  });

  it("pinCloudResource", async () => {
    await pinCloudResource("org1", "d1", "r1");
    expect(invoke).toHaveBeenCalledWith("cloud_pin_resource", {
      orgId: "org1",
      dashboardId: "d1",
      resourceId: "r1",
    });
  });

  it("unpinCloudResource", async () => {
    await unpinCloudResource("org1", "d1", "r1");
    expect(invoke).toHaveBeenCalledWith("cloud_unpin_resource", {
      orgId: "org1",
      dashboardId: "d1",
      resourceId: "r1",
    });
  });

  it("reorderCloudCards sends the whole mixed grid", async () => {
    await reorderCloudCards("org1", "d1", [
      { kind: "resource", id: "a" },
      { kind: "widget", id: "w1" },
      { kind: "resource", id: "b" },
    ]);
    expect(invoke).toHaveBeenCalledWith("cloud_reorder_pins", {
      orgId: "org1",
      dashboardId: "d1",
      cards: [
        { kind: "resource", id: "a" },
        { kind: "widget", id: "w1" },
        { kind: "resource", id: "b" },
      ],
    });
  });

  it("probeCloudPins", async () => {
    invoke.mockResolvedValue({ r1: "ok" });
    const items = [{ resourceId: "r1", accountId: "a", pluginId: "p", resourceTypeId: "t" }];
    const res = await probeCloudPins("org1", items);
    expect(invoke).toHaveBeenCalledWith("cloud_probe_pins", { orgId: "org1", items });
    expect(res).toEqual({ r1: "ok" });
  });

  it("getCloudEnrichedPin", async () => {
    await getCloudEnrichedPin("org1", "pin1");
    expect(invoke).toHaveBeenCalledWith("cloud_get_pin", { orgId: "org1", pinId: "pin1" });
  });
});
