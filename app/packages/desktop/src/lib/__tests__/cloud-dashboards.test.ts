/**
 * The cloud dashboard wrappers over the cloud transport (`CloudHttp`): the
 * method, URL and body each one sends, and what it hands back.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../rpc/client", async () => (await import("./fake-rpc")).fakeRpcClientModule);
vi.mock("../rpc/desktop-client", async () => (await import("./fake-rpc")).fakeRpcClientModule);

const { answerCloudHttp, resetFakeRpc } = await import("./fake-rpc");
const {
  clearMyCloudDefaultDashboard,
  createCloudDashboardDefaultClient,
  getCloudDefaultDashboard,
  setMyCloudDefaultDashboard,
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
  validateCloudWorkspaceTabs,
} = await import("../cloud-dashboards");

const ORG = "/api/org/org1";

beforeEach(() => {
  resetFakeRpc();
});

/** Every request the transport received, bodies parsed. */
function requests(http: ReturnType<typeof answerCloudHttp>) {
  return http.mock.calls.map(([request]) => ({
    method: request.method,
    url: request.url,
    ...(request.body === undefined ? {} : { body: JSON.parse(request.body) }),
  }));
}

describe("cloud-dashboards wrappers", () => {
  it("listCloudDashboards", async () => {
    const http = answerCloudHttp(() => ({ status: 200, json: [] }));
    await listCloudDashboards("org1");
    expect(requests(http)).toEqual([{ method: "GET", url: `${ORG}/dashboards` }]);
  });

  it("getCloudDashboard", async () => {
    const http = answerCloudHttp(() => ({ status: 200, json: {} }));
    await getCloudDashboard("org1", "d1");
    expect(requests(http)).toEqual([{ method: "GET", url: `${ORG}/dashboards/d1` }]);
  });

  it("createCloudDashboard", async () => {
    const http = answerCloudHttp(() => ({ status: 200, json: { id: "d1", name: "Home" } }));
    await createCloudDashboard("org1", "Home");
    expect(requests(http)).toEqual([
      { method: "POST", url: `${ORG}/dashboards`, body: { name: "Home" } },
    ]);
  });

  it("deleteCloudDashboard", async () => {
    const http = answerCloudHttp(() => ({ status: 200, json: { ok: true } }));
    await deleteCloudDashboard("org1", "d1");
    expect(requests(http)).toEqual([{ method: "DELETE", url: `${ORG}/dashboards/d1` }]);
  });

  it("default dashboard wrappers", async () => {
    const http = answerCloudHttp(() => ({ status: 200, json: {} }));
    await getCloudDefaultDashboard("org1");
    await setMyCloudDefaultDashboard("org1", "d1");
    await clearMyCloudDefaultDashboard("org1");
    expect(requests(http)).toEqual([
      { method: "GET", url: `${ORG}/dashboards/default` },
      { method: "PUT", url: `${ORG}/dashboards/default/me`, body: { dashboardId: "d1" } },
      { method: "DELETE", url: `${ORG}/dashboards/default/me` },
    ]);
  });

  it("createCloudDashboardDefaultClient routes through the same calls", async () => {
    const http = answerCloudHttp(() => ({ status: 200, json: {} }));
    const client = createCloudDashboardDefaultClient("org1");
    await client.setMine("d2");
    expect(requests(http)).toEqual([
      { method: "PUT", url: `${ORG}/dashboards/default/me`, body: { dashboardId: "d2" } },
    ]);
  });

  it("renameCloudDashboard", async () => {
    const http = answerCloudHttp(() => ({ status: 200, json: { ok: true } }));
    await renameCloudDashboard("org1", "d1", "New");
    expect(requests(http)).toEqual([
      { method: "POST", url: `${ORG}/dashboards/d1/rename`, body: { name: "New" } },
    ]);
  });

  it("pinCloudResource", async () => {
    const http = answerCloudHttp(() => ({ status: 200, json: { ok: true } }));
    await pinCloudResource("org1", "d1", "r1");
    expect(requests(http)).toEqual([
      {
        method: "POST",
        url: `${ORG}/dashboards/pin`,
        body: { dashboardId: "d1", resourceId: "r1" },
      },
    ]);
  });

  it("unpinCloudResource", async () => {
    const http = answerCloudHttp(() => ({ status: 200, json: { ok: true } }));
    await unpinCloudResource("org1", "d1", "r1");
    expect(requests(http)).toEqual([
      {
        method: "POST",
        url: `${ORG}/dashboards/unpin`,
        body: { dashboardId: "d1", resourceId: "r1" },
      },
    ]);
  });

  it("reorderCloudCards sends the whole mixed grid", async () => {
    const http = answerCloudHttp(() => ({ status: 200, json: { ok: true } }));
    const cards = [
      { kind: "resource" as const, id: "a" },
      { kind: "widget" as const, id: "w1" },
      { kind: "resource" as const, id: "b" },
    ];
    await reorderCloudCards("org1", "d1", cards);
    expect(requests(http)).toEqual([
      { method: "POST", url: `${ORG}/dashboards/d1/reorder`, body: { cards } },
    ]);
  });

  it("probeCloudPins", async () => {
    const http = answerCloudHttp(() => ({ status: 200, json: { r1: "ok" } }));
    const items = [{ resourceId: "r1", accountId: "a", pluginId: "p", resourceTypeId: "t" }];
    const res = await probeCloudPins("org1", items);
    expect(requests(http)).toEqual([
      { method: "POST", url: `${ORG}/dashboards/probe`, body: { items } },
    ]);
    expect(res).toEqual({ r1: "ok" });
  });

  it("validateCloudWorkspaceTabs returns the ids the org still has", async () => {
    const http = answerCloudHttp(() => ({ status: 200, json: { validTabIds: ["dashboard:d1"] } }));
    const tabs = [
      { id: "dashboard:d1", target: { kind: "dashboard" as const, dashboardId: "d1" } },
      { id: "dashboard:d2", target: { kind: "dashboard" as const, dashboardId: "d2" } },
    ];
    const res = await validateCloudWorkspaceTabs("org1", tabs);
    expect(requests(http)).toEqual([
      { method: "POST", url: `${ORG}/dashboards/validate-tabs`, body: { tabs } },
    ]);
    expect(res).toEqual(["dashboard:d1"]);
  });

  it("validateCloudWorkspaceTabs tolerates an empty answer", async () => {
    answerCloudHttp(() => ({ status: 204 }));
    expect(await validateCloudWorkspaceTabs("org1", [])).toEqual([]);
  });

  it("getCloudEnrichedPin", async () => {
    const http = answerCloudHttp(() => ({ status: 200, json: {} }));
    await getCloudEnrichedPin("org1", "pin1");
    expect(requests(http)).toEqual([{ method: "GET", url: `${ORG}/dashboards/pin/pin1` }]);
  });

  it("shows the server's failure in the words the handlers used", async () => {
    answerCloudHttp(() => ({ status: 404, json: { error: "Dashboard not found" } }));
    await expect(getCloudDashboard("org1", "d1")).rejects.toThrow(
      'Cloud request failed: 404 /dashboards/d1 {"error":"Dashboard not found"}',
    );
  });
});
