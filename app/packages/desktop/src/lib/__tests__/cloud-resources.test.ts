/**
 * The resource wrappers in `cloud-resources.ts`: what each sends over the
 * cloud transport (`CloudHttp`), and what it hands back. The tunnel attach
 * still rides its own IPC channel (its answer is undocumented in the
 * contract), so that one is asserted on `invoke`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../rpc/client", async () => (await import("./fake-rpc")).fakeRpcClientModule);
vi.mock("../rpc/desktop-client", async () => (await import("./fake-rpc")).fakeRpcClientModule);

const invoke = vi.fn();
vi.mock("../invoke", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

const { answerCloudHttp, resetFakeRpc } = await import("./fake-rpc");
const {
  applyCloudManifest,
  cloudListSshKeys,
  cloudTunnelSshAttach,
  createCloudResource,
  deleteCloudResource,
  exportCloudCredential,
  fetchCloudBlastRadius,
  fetchCloudDependencyGraph,
  getCloudCreateConfig,
  getCloudCostEstimate,
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
} = await import("../cloud-resources");

const ORG = "/api/org/org1";
const ok = { ok: true };

beforeEach(() => {
  resetFakeRpc();
  invoke.mockReset();
  invoke.mockResolvedValue(undefined);
});

/** The one request the transport received, with its body parsed. */
function sent(http: ReturnType<typeof answerCloudHttp>) {
  expect(http).toHaveBeenCalledTimes(1);
  const request = http.mock.calls[0]![0];
  return {
    method: request.method,
    url: request.url,
    body: request.body === undefined ? undefined : JSON.parse(request.body),
  };
}

describe("cloud-resources conditional arg-spreading", () => {
  it("getCloudResourceDetail omits includePeerPanes when not given", async () => {
    const http = answerCloudHttp(() => ({ status: 200, json: {} }));
    await getCloudResourceDetail("org1", "p", "t", "r", "acc");
    expect(sent(http)).toEqual({
      method: "GET",
      url: `${ORG}/resources/p/t/detail?resourceId=r&accountId=acc`,
      body: undefined,
    });
  });

  it("getCloudResourceDetail sends the parent, and includePeerPanes only when false", async () => {
    const http = answerCloudHttp(() => ({ status: 200, json: {} }));
    await getCloudResourceDetail("org1", "p", "t", "r", "acc", "parent", {
      includePeerPanes: true,
    });
    expect(sent(http).url).toBe(
      `${ORG}/resources/p/t/detail?resourceId=r&accountId=acc&parentResourceId=parent`,
    );

    http.mockClear();
    await getCloudResourceDetail("org1", "p", "t", "r", "acc", undefined, {
      includePeerPanes: false,
    });
    expect(sent(http).url).toBe(
      `${ORG}/resources/p/t/detail?resourceId=r&accountId=acc&includePeerPanes=false`,
    );
  });

  it("getCloudCreatePricing omits regionId when absent", async () => {
    const http = answerCloudHttp(() => ({ status: 200, json: {} }));
    await getCloudCreatePricing("org1", "acc", "t", { sizes: [] });
    const { url, body } = sent(http);
    expect(url).toBe(`${ORG}/resources/create-pricing`);
    expect(body).not.toHaveProperty("regionId");
    expect(body.sizes).toEqual([]);
  });

  it("getCloudCreatePricing includes regionId when present", async () => {
    const http = answerCloudHttp(() => ({ status: 200, json: {} }));
    await getCloudCreatePricing("org1", "acc", "t", { regionId: "us", sizes: [] });
    expect(sent(http).body.regionId).toBe("us");
  });

  it("getCloudLogs spreads params", async () => {
    const http = answerCloudHttp(() => ({
      status: 200,
      json: { text: "", containers: [], activeContainer: "" },
    }));
    await getCloudLogs("org1", "p", "t", "r", "acc", { tailLines: 50, container: "main" });
    expect(sent(http)).toEqual({
      method: "POST",
      url: `${ORG}/resources/p/t/logs`,
      body: { accountId: "acc", resourceId: "r", tailLines: 50, container: "main" },
    });
  });

  it("loadCloudPickerResources omits optional opts", async () => {
    const http = answerCloudHttp(() => ({ status: 200, json: [] }));
    await loadCloudPickerResources("org1", [], "acc");
    const { url, body } = sent(http);
    expect(url).toBe(`${ORG}/resources/picker-resources`);
    expect(body).not.toHaveProperty("regionHint");
    expect(body).not.toHaveProperty("crossAccount");
  });

  it("loadCloudPickerResources includes regionHint and crossAccount", async () => {
    const http = answerCloudHttp(() => ({ status: 200, json: [] }));
    await loadCloudPickerResources("org1", [], "acc", { regionHint: "eu", crossAccount: true });
    const { body } = sent(http);
    expect(body.regionHint).toBe("eu");
    expect(body.crossAccount).toBe(true);
  });

  it("runCloudNoSqlCommand unwraps .result", async () => {
    const http = answerCloudHttp(() => ({ status: 200, json: { result: { rows: 3 } } }));
    const body = {
      pluginId: "p",
      accountId: "acc",
      resourceTypeId: "t",
      resourceId: "r",
      command: "find",
      args: [],
    };
    const res = await runCloudNoSqlCommand("org1", body);
    expect(sent(http)).toEqual({ method: "POST", url: `${ORG}/resources/nosql-command`, body });
    expect(res).toEqual({ rows: 3 });
  });
});

describe("cloud-resources straightforward wrappers", () => {
  it("fetchCloudDependencyGraph narrows to one resource only when asked", async () => {
    const http = answerCloudHttp(() => ({ status: 200, json: { nodes: [], edges: [] } }));
    await fetchCloudDependencyGraph("org1");
    expect(sent(http).url).toBe(`${ORG}/dependency-graph`);

    http.mockClear();
    await fetchCloudDependencyGraph("org1", "aws:a:i/1");
    expect(sent(http).url).toBe(`${ORG}/dependency-graph?resourceId=aws%3Aa%3Ai%2F1`);
  });

  it("fetchCloudBlastRadius", async () => {
    const http = answerCloudHttp(() => ({ status: 200, json: {} }));
    await fetchCloudBlastRadius("org1", "aws:a:r");
    expect(sent(http)).toEqual({
      method: "GET",
      url: `${ORG}/blast-radius?resourceId=aws%3Aa%3Ar`,
      body: undefined,
    });
  });

  it("createCloudResource", async () => {
    const http = answerCloudHttp(() => ({ status: 200, json: { id: "x", displayName: "X" } }));
    const body = { accountId: "a", pluginId: "p", resourceTypeId: "t", fields: {} };
    await expect(createCloudResource("org1", body)).resolves.toEqual({
      id: "x",
      displayName: "X",
    });
    expect(sent(http)).toEqual({ method: "POST", url: `${ORG}/resources/create`, body });
  });

  it("updateCloudResource", async () => {
    const http = answerCloudHttp(() => ({
      status: 200,
      json: { id: "x", displayName: "X", fields: {} },
    }));
    const body = {
      accountId: "a",
      pluginId: "p",
      resourceTypeId: "t",
      resourceId: "r",
      fields: {},
    };
    await updateCloudResource("org1", body);
    expect(sent(http)).toEqual({ method: "POST", url: `${ORG}/resources/update`, body });
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
    const http = answerCloudHttp(() => ({ status: 200, json: [] }));
    await cloudListSshKeys("org1");
    expect(sent(http)).toEqual({ method: "GET", url: `${ORG}/ssh-keys`, body: undefined });
  });

  it("getCloudCreateConfig", async () => {
    const http = answerCloudHttp(() => ({ status: 200, json: {} }));
    await getCloudCreateConfig("org1", "acc", "t", "p", "parent");
    expect(sent(http)).toEqual({
      method: "POST",
      url: `${ORG}/resources/create-config`,
      body: { accountId: "acc", resourceTypeId: "t", pluginId: "p", parentResourceId: "parent" },
    });
  });

  it("getCloudCostEstimate unwraps the estimate and omits absent options", async () => {
    const estimate = { monthlyAmount: 9.19, currency: "USD", lineItems: [] };
    const http = answerCloudHttp(() => ({ status: 200, json: { estimate } }));
    expect(
      await getCloudCostEstimate("org1", "acc", "ec2-instance", { fields: { f: "v" } }),
    ).toEqual(estimate);
    expect(sent(http)).toEqual({
      method: "POST",
      url: `${ORG}/resources/cost-estimate`,
      body: { accountId: "acc", resourceTypeId: "ec2-instance", fields: { f: "v" } },
    });
  });

  it("getCloudCostEstimate prices an existing resource by id", async () => {
    const http = answerCloudHttp(() => ({ status: 200, json: { estimate: null } }));
    expect(
      await getCloudCostEstimate("org1", "acc", "ec2-instance", { resourceId: "acc:t:i-1" }),
    ).toBeNull();
    expect(sent(http).body).toEqual({
      accountId: "acc",
      resourceTypeId: "ec2-instance",
      resourceId: "acc:t:i-1",
    });
  });

  it("deleteCloudResource", async () => {
    const http = answerCloudHttp(() => ({ status: 200, json: ok }));
    await deleteCloudResource("org1", "p", "t", "r", "acc");
    expect(sent(http)).toEqual({
      method: "DELETE",
      url: `${ORG}/resources/p/t?resourceId=r&accountId=acc`,
      body: undefined,
    });
  });

  it("exportCloudCredential", async () => {
    const http = answerCloudHttp(() => ({
      status: 200,
      json: { content: "", filename: "f", mimeType: "text/plain" },
    }));
    await exportCloudCredential("org1", "p", "t", "r", "acc", "fmt");
    expect(sent(http)).toEqual({
      method: "POST",
      url: `${ORG}/resources/p/t/export-credential`,
      body: { resourceId: "r", accountId: "acc", formatId: "fmt" },
    });
  });

  it("getCloudManifest", async () => {
    const http = answerCloudHttp(() => ({ status: 200, json: { manifest: "yaml" } }));
    await expect(getCloudManifest("org1", "p", "t", "r", "acc")).resolves.toEqual({
      manifest: "yaml",
    });
    expect(sent(http).url).toBe(`${ORG}/resources/p/t/manifest?resourceId=r&accountId=acc`);
  });

  it("applyCloudManifest", async () => {
    const http = answerCloudHttp(() => ({ status: 200, json: ok }));
    const body = { accountId: "a", resourceId: "r", manifest: "y" };
    await applyCloudManifest("org1", "p", "t", body);
    expect(sent(http)).toEqual({ method: "POST", url: `${ORG}/resources/p/t/manifest`, body });
  });

  it("invokeCloudAction", async () => {
    const http = answerCloudHttp(() => ({ status: 200, json: ok }));
    const body = {
      pluginId: "p",
      accountId: "a",
      resourceTypeId: "t",
      resourceId: "r",
      actionId: "act",
    };
    await invokeCloudAction("org1", body);
    expect(sent(http)).toEqual({ method: "POST", url: `${ORG}/resources/invoke-action`, body });
  });

  it("importCloudYaml", async () => {
    const http = answerCloudHttp(() => ({ status: 200, json: { applied: 2 } }));
    const body = { accountId: "a", yaml: "y" };
    await expect(importCloudYaml("org1", "p", body)).resolves.toEqual({ applied: 2 });
    expect(sent(http)).toEqual({ method: "POST", url: `${ORG}/resources/p/import-yaml`, body });
  });

  it("getCloudDescribe", async () => {
    const http = answerCloudHttp(() => ({ status: 200, json: { text: "" } }));
    await getCloudDescribe("org1", "p", "t", "r", "acc");
    expect(sent(http)).toEqual({
      method: "POST",
      url: `${ORG}/resources/p/t/describe`,
      body: { accountId: "acc", resourceId: "r" },
    });
  });

  it("shows the server's failure in the words the handlers used", async () => {
    answerCloudHttp(() => ({ status: 423, json: { error: "frozen" } }));
    await expect(
      invokeCloudAction("org1", {
        pluginId: "p",
        accountId: "a",
        resourceTypeId: "t",
        resourceId: "r",
        actionId: "act",
      }),
    ).rejects.toThrow('Cloud request failed: 423 /resources/invoke-action {"error":"frozen"}');
  });
});
