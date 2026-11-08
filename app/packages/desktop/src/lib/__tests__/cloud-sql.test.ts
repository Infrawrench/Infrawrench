import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../rpc/client", async () => (await import("./fake-rpc")).fakeRpcClientModule);
vi.mock("../rpc/desktop-client", async () => (await import("./fake-rpc")).fakeRpcClientModule);

const { answerCloudHttp, resetFakeRpc } = await import("./fake-rpc");
const {
  cloudKvBrowserDelete,
  cloudKvBrowserGet,
  cloudKvBrowserList,
  cloudKvBrowserPut,
  cloudKvCommand,
  cloudListArtifacts,
  cloudSqlEstimate,
  cloudSqlExecute,
  cloudSqlQuery,
} = await import("../cloud-sql");

const answer = () => answerCloudHttp(() => ({ status: 200, json: { ok: true } }));

beforeEach(() => {
  resetFakeRpc();
});

function posted(path: string, body: unknown) {
  return { method: "POST", url: `/api/org/org1${path}`, body: JSON.stringify(body) };
}

describe("cloud-sql wrappers", () => {
  it("cloudSqlQuery wraps body", async () => {
    const http = answerCloudHttp(() => ({ status: 200, json: { rows: [{ n: 1 }] } }));
    const body = { accountId: "a", sql: "SELECT 1" };
    await expect(cloudSqlQuery("org1", body)).resolves.toEqual({ rows: [{ n: 1 }] });
    expect(http).toHaveBeenCalledWith(posted("/sql/query", body));
  });

  it("cloudListArtifacts", async () => {
    const http = answer();
    const body = { accountId: "a", resourceId: "r", resourceTypeId: "t" };
    await cloudListArtifacts("org1", body);
    expect(http).toHaveBeenCalledWith(posted("/artifacts/list", body));
  });

  it("cloudSqlExecute", async () => {
    const http = answerCloudHttp(() => ({ status: 200, json: { affectedRows: 1 } }));
    const body = { accountId: "a", sql: "DELETE FROM t", params: [1] };
    await cloudSqlExecute("org1", body);
    expect(http).toHaveBeenCalledWith(posted("/sql/execute", body));
  });

  it("cloudSqlEstimate", async () => {
    const http = answer();
    const body = { accountId: "a", resourceId: "r", sql: "SELECT 1" };
    await cloudSqlEstimate("org1", body);
    expect(http).toHaveBeenCalledWith(posted("/sql/estimate", body));
  });

  it("cloudKvCommand", async () => {
    const http = answerCloudHttp(() => ({ status: 200, json: { result: "v" } }));
    const body = { accountId: "a", command: "GET", args: ["k"] };
    await cloudKvCommand("org1", body);
    expect(http).toHaveBeenCalledWith(posted("/kv/command", body));
  });

  it("cloudKvBrowserList", async () => {
    const http = answer();
    const body = { accountId: "a", resourceTypeId: "t", resourceId: "r" };
    await cloudKvBrowserList("org1", body);
    expect(http).toHaveBeenCalledWith(posted("/kv-browser/list", body));
  });

  it("cloudKvBrowserGet", async () => {
    const http = answer();
    const body = { accountId: "a", resourceTypeId: "t", resourceId: "r", key: "k" };
    await cloudKvBrowserGet("org1", body);
    expect(http).toHaveBeenCalledWith(posted("/kv-browser/get", body));
  });

  it("cloudKvBrowserPut", async () => {
    const http = answer();
    const body = { accountId: "a", resourceTypeId: "t", resourceId: "r", key: "k", value: "v" };
    await cloudKvBrowserPut("org1", body);
    expect(http).toHaveBeenCalledWith(posted("/kv-browser/put", body));
  });

  it("cloudKvBrowserDelete", async () => {
    const http = answer();
    const body = { accountId: "a", resourceTypeId: "t", resourceId: "r", key: "k" };
    await cloudKvBrowserDelete("org1", body);
    expect(http).toHaveBeenCalledWith(posted("/kv-browser/delete", body));
  });

  it("shows the server's failure in the words the handler used", async () => {
    answerCloudHttp(() => ({ status: 400, json: { error: "bad sql" } }));
    await expect(cloudSqlQuery("org1", { accountId: "a", sql: "x" })).rejects.toThrow(
      'Cloud request failed: 400 /sql/query {"error":"bad sql"}',
    );
  });
});
