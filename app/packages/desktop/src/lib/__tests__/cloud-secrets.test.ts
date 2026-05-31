import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("../invoke", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

import {
  accessCloudSecretVersion,
  addCloudSecretVersion,
  listCloudSecretVersions,
  modifyCloudSecretVersion,
} from "../cloud-secrets";

beforeEach(() => {
  invoke.mockReset();
  invoke.mockResolvedValue(undefined);
});

describe("cloud-secrets wrappers", () => {
  it("listCloudSecretVersions", async () => {
    invoke.mockResolvedValue({ versions: [] });
    await listCloudSecretVersions("org1", "p", "t", "r", "acc", "parent");
    expect(invoke).toHaveBeenCalledWith("cloud_list_secret_versions", {
      orgId: "org1",
      pluginId: "p",
      resourceTypeId: "t",
      resourceId: "r",
      accountId: "acc",
      parentResourceId: "parent",
    });
  });

  it("accessCloudSecretVersion", async () => {
    invoke.mockResolvedValue({ value: "secret" });
    const body = { accountId: "acc", resourceId: "r", versionId: "v1" };
    const res = await accessCloudSecretVersion("org1", "p", "t", body);
    expect(invoke).toHaveBeenCalledWith("cloud_access_secret_version", {
      orgId: "org1",
      pluginId: "p",
      resourceTypeId: "t",
      body,
    });
    expect(res).toEqual({ value: "secret" });
  });

  it("addCloudSecretVersion", async () => {
    invoke.mockResolvedValue({ version: {} });
    const body = { accountId: "acc", resourceId: "r", value: "new" };
    await addCloudSecretVersion("org1", "p", "t", body);
    expect(invoke).toHaveBeenCalledWith("cloud_add_secret_version", {
      orgId: "org1",
      pluginId: "p",
      resourceTypeId: "t",
      body,
    });
  });

  it("modifyCloudSecretVersion", async () => {
    invoke.mockResolvedValue({ version: {} });
    const body = {
      accountId: "acc",
      resourceId: "r",
      versionId: "v1",
      action: "disable" as const,
    };
    await modifyCloudSecretVersion("org1", "p", "t", body);
    expect(invoke).toHaveBeenCalledWith("cloud_modify_secret_version", {
      orgId: "org1",
      pluginId: "p",
      resourceTypeId: "t",
      body,
    });
  });
});
