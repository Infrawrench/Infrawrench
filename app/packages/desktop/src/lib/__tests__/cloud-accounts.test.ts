import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../rpc/client", async () => (await import("./fake-rpc")).fakeRpcClientModule);
vi.mock("../rpc/desktop-client", async () => (await import("./fake-rpc")).fakeRpcClientModule);

const { answerCloudHttp, resetFakeRpc } = await import("./fake-rpc");
const {
  createCloudAccount,
  deleteCloudAccount,
  getCloudAccountCredentials,
  getCloudAccountDetail,
  listCloudAccountPlugins,
  listCloudAccountResources,
  listCloudAccounts,
  renameCloudAccount,
  syncCloudAccountType,
  updateCloudAccountCredentials,
} = await import("../cloud-accounts");

beforeEach(() => {
  resetFakeRpc();
});

const ok = () => answerCloudHttp(() => ({ status: 200, json: { ok: true } }));

describe("cloud-accounts wrappers", () => {
  it("listCloudAccounts reads the org's accounts", async () => {
    const http = answerCloudHttp(() => ({ status: 200, json: [{ id: "a" }] }));
    const res = await listCloudAccounts("org1");
    expect(http).toHaveBeenCalledWith({ method: "GET", url: "/api/org/org1/accounts" });
    expect(res).toEqual([{ id: "a" }]);
  });

  it("listCloudAccountPlugins reads the server's plugin catalog", async () => {
    const http = answerCloudHttp(() => ({ status: 200, json: [{ id: "github", oauth: {} }] }));
    await expect(listCloudAccountPlugins("org1")).resolves.toEqual([{ id: "github", oauth: {} }]);
    expect(http).toHaveBeenCalledWith({ method: "GET", url: "/api/org/org1/accounts/plugins" });
  });

  it("createCloudAccount posts the plugin, name and credentials", async () => {
    const http = answerCloudHttp(() => ({ status: 201, json: { id: "acc" } }));
    const res = await createCloudAccount("org1", "plugin", "Name", { k: "v" });
    expect(http).toHaveBeenCalledWith({
      method: "POST",
      url: "/api/org/org1/accounts",
      body: JSON.stringify({ pluginId: "plugin", displayName: "Name", credentials: { k: "v" } }),
    });
    expect(res).toEqual({ id: "acc" });
  });

  it("listCloudAccountResources reads only top-level resources", async () => {
    const http = answerCloudHttp(() => ({ status: 200, json: [] }));
    await listCloudAccountResources("org1", "acc1");
    expect(http).toHaveBeenCalledWith({
      method: "GET",
      url: "/api/org/org1/accounts/acc1/resources?topLevelOnly=true",
    });
  });

  it("getCloudAccountDetail fills the plural name a type left out", async () => {
    const http = answerCloudHttp(() => ({
      status: 200,
      json: {
        account: { id: "acc1", pluginId: "aws", displayName: "Prod", oauthStatus: null },
        resourceTypes: [
          {
            id: "ec2",
            displayName: "Instance",
            pluralDisplayName: "Instances",
            supportsCreate: true,
          },
          { id: "vol", displayName: "Volume", parentTypeId: "ec2", supportsCreate: false },
        ],
        pluginDisplayName: "AWS",
        pluginLogoSvg: "<svg/>",
      },
    }));
    const detail = await getCloudAccountDetail("org1", "acc1");
    expect(http).toHaveBeenCalledWith({ method: "GET", url: "/api/org/org1/accounts/acc1/detail" });
    expect(detail?.resourceTypes.map((t) => [t.pluralDisplayName, t.parentTypeId])).toEqual([
      ["Instances", undefined],
      ["Volume", "ec2"],
    ]);
  });

  it("syncCloudAccountType posts to the type's sync route", async () => {
    const http = answerCloudHttp(() => ({ status: 200, json: [] }));
    await syncCloudAccountType("org1", "acc1", "type1");
    expect(http).toHaveBeenCalledWith({
      method: "POST",
      url: "/api/org/org1/accounts/acc1/sync-type/type1",
    });
  });

  it("deleteCloudAccount deletes the account", async () => {
    const http = ok();
    await expect(deleteCloudAccount("org1", "acc1")).resolves.toBeUndefined();
    expect(http).toHaveBeenCalledWith({ method: "DELETE", url: "/api/org/org1/accounts/acc1" });
  });

  it("renameCloudAccount patches the display name", async () => {
    const http = answerCloudHttp(() => ({ status: 200, json: { id: "acc1", displayName: "New" } }));
    await renameCloudAccount("org1", "acc1", "New");
    expect(http).toHaveBeenCalledWith({
      method: "PATCH",
      url: "/api/org/org1/accounts/acc1",
      body: JSON.stringify({ displayName: "New" }),
    });
  });

  it("getCloudAccountCredentials reads the stored credentials", async () => {
    const http = answerCloudHttp(() => ({ status: 200, json: { token: "t" } }));
    await expect(getCloudAccountCredentials("org1", "acc1")).resolves.toEqual({ token: "t" });
    expect(http).toHaveBeenCalledWith({
      method: "GET",
      url: "/api/org/org1/accounts/acc1/credentials",
    });
  });

  it("updateCloudAccountCredentials puts the whole credentials map", async () => {
    const http = ok();
    await updateCloudAccountCredentials("org1", "acc1", { token: "t" });
    expect(http).toHaveBeenCalledWith({
      method: "PUT",
      url: "/api/org/org1/accounts/acc1/credentials",
      body: JSON.stringify({ credentials: { token: "t" } }),
    });
  });
});
