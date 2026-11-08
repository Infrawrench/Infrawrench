import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../rpc/client", async () => (await import("./fake-rpc")).fakeRpcClientModule);
vi.mock("../rpc/desktop-client", async () => (await import("./fake-rpc")).fakeRpcClientModule);

const { answerCloudHttp, resetFakeRpc } = await import("./fake-rpc");
const {
  accessCloudSecretVersion,
  addCloudSecretVersion,
  listCloudSecretVersions,
  modifyCloudSecretVersion,
} = await import("../cloud-secrets");

beforeEach(() => {
  resetFakeRpc();
});

/** The one request sent, with its JSON body parsed (the encoder writes keys in schema order). */
function sent(http: ReturnType<typeof answerCloudHttp>) {
  expect(http).toHaveBeenCalledTimes(1);
  const request = http.mock.calls[0]![0];
  return { ...request, body: request.body === undefined ? undefined : JSON.parse(request.body) };
}

describe("cloud-secrets wrappers", () => {
  it("listCloudSecretVersions", async () => {
    const http = answerCloudHttp(() => ({ status: 200, json: { versions: [] } }));
    await listCloudSecretVersions("org1", "p", "t", "r", "acc", "parent");
    expect(http).toHaveBeenCalledWith({
      method: "GET",
      url: "/api/org/org1/resources/p/t/secret-versions?resourceId=r&accountId=acc&parentResourceId=parent",
    });
  });

  it("listCloudSecretVersions leaves out an absent parent", async () => {
    const http = answerCloudHttp(() => ({ status: 200, json: { versions: [] } }));
    await listCloudSecretVersions("org1", "p", "t", "r", "acc");
    expect(http).toHaveBeenCalledWith({
      method: "GET",
      url: "/api/org/org1/resources/p/t/secret-versions?resourceId=r&accountId=acc",
    });
  });

  it("accessCloudSecretVersion", async () => {
    const http = answerCloudHttp(() => ({ status: 200, json: { value: "secret" } }));
    const body = { accountId: "acc", resourceId: "r", versionId: "v1" };
    const res = await accessCloudSecretVersion("org1", "p", "t", body);
    expect(sent(http)).toEqual({
      method: "POST",
      url: "/api/org/org1/resources/p/t/secret-versions/access",
      body,
    });
    expect(res).toEqual({ value: "secret" });
  });

  it("addCloudSecretVersion", async () => {
    const http = answerCloudHttp(() => ({ status: 200, json: { version: {} } }));
    const body = { accountId: "acc", resourceId: "r", value: "new" };
    await addCloudSecretVersion("org1", "p", "t", body);
    expect(sent(http)).toEqual({
      method: "POST",
      url: "/api/org/org1/resources/p/t/secret-versions/add",
      body,
    });
  });

  it("modifyCloudSecretVersion", async () => {
    const http = answerCloudHttp(() => ({ status: 200, json: { version: {} } }));
    const body = {
      accountId: "acc",
      resourceId: "r",
      versionId: "v1",
      action: "disable" as const,
    };
    await modifyCloudSecretVersion("org1", "p", "t", body);
    expect(sent(http)).toEqual({
      method: "POST",
      url: "/api/org/org1/resources/p/t/secret-versions/modify",
      body,
    });
  });
});
