import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("../invoke", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

import {
  createCloudAccount,
  deleteCloudAccount,
  getCloudAccountDetail,
  listCloudAccountResources,
  listCloudAccounts,
  renameCloudAccount,
  syncCloudAccountType,
  updateCloudAccountCredentials,
} from "../cloud-accounts";

beforeEach(() => {
  invoke.mockReset();
  invoke.mockResolvedValue(undefined);
});

describe("cloud-accounts wrappers", () => {
  it("listCloudAccounts -> cloud_list_accounts", async () => {
    invoke.mockResolvedValue([{ id: "a" }]);
    const res = await listCloudAccounts("org1");
    expect(invoke).toHaveBeenCalledWith("cloud_list_accounts", { orgId: "org1" });
    expect(res).toEqual([{ id: "a" }]);
  });

  it("createCloudAccount -> cloud_create_account", async () => {
    invoke.mockResolvedValue({ id: "acc" });
    const res = await createCloudAccount("org1", "plugin", "Name", { k: "v" });
    expect(invoke).toHaveBeenCalledWith("cloud_create_account", {
      orgId: "org1",
      pluginId: "plugin",
      displayName: "Name",
      credentials: { k: "v" },
    });
    expect(res).toEqual({ id: "acc" });
  });

  it("listCloudAccountResources -> cloud_list_account_resources", async () => {
    await listCloudAccountResources("org1", "acc1");
    expect(invoke).toHaveBeenCalledWith("cloud_list_account_resources", {
      orgId: "org1",
      accountId: "acc1",
    });
  });

  it("getCloudAccountDetail -> cloud_get_account_detail", async () => {
    await getCloudAccountDetail("org1", "acc1");
    expect(invoke).toHaveBeenCalledWith("cloud_get_account_detail", {
      orgId: "org1",
      accountId: "acc1",
    });
  });

  it("syncCloudAccountType -> cloud_sync_account_type", async () => {
    await syncCloudAccountType("org1", "acc1", "type1");
    expect(invoke).toHaveBeenCalledWith("cloud_sync_account_type", {
      orgId: "org1",
      accountId: "acc1",
      typeId: "type1",
    });
  });

  it("deleteCloudAccount -> cloud_delete_account", async () => {
    await deleteCloudAccount("org1", "acc1");
    expect(invoke).toHaveBeenCalledWith("cloud_delete_account", {
      orgId: "org1",
      accountId: "acc1",
    });
  });

  it("renameCloudAccount -> cloud_rename_account", async () => {
    await renameCloudAccount("org1", "acc1", "New");
    expect(invoke).toHaveBeenCalledWith("cloud_rename_account", {
      orgId: "org1",
      accountId: "acc1",
      displayName: "New",
    });
  });

  it("updateCloudAccountCredentials -> cloud_update_account_credentials", async () => {
    await updateCloudAccountCredentials("org1", "acc1", { token: "t" });
    expect(invoke).toHaveBeenCalledWith("cloud_update_account_credentials", {
      orgId: "org1",
      accountId: "acc1",
      credentials: { token: "t" },
    });
  });
});
