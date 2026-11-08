/**
 * The incident wrappers over the cloud transport: what each call sends, and
 * the paging action check that runs before anything is sent.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../rpc/client", async () => (await import("./fake-rpc")).fakeRpcClientModule);
vi.mock("../rpc/desktop-client", async () => (await import("./fake-rpc")).fakeRpcClientModule);

const { answerCloudHttp, resetFakeRpc } = await import("./fake-rpc");
const {
  actOnCloudPagerIncident,
  addCloudIncidentNote,
  deleteCloudIncidentNote,
  listCloudIncidents,
  listCloudPagerIncidents,
  retryCloudIncidentArtifacts,
} = await import("../cloud-incidents");

const ORG = "org-1";
const INCIDENT = "00000000-0000-0000-0000-000000000001";

beforeEach(() => {
  resetFakeRpc();
});

describe("declared incidents", () => {
  it("lists every incident without a status filter for `all`", async () => {
    const http = answerCloudHttp(() => ({ status: 200, json: { incidents: [] } }));

    await listCloudIncidents(ORG, "all");
    await listCloudIncidents(ORG, "open");

    expect(http.mock.calls.map(([request]) => request.url)).toEqual([
      `/api/org/${ORG}/incidents`,
      `/api/org/${ORG}/incidents?status=open`,
    ]);
  });

  it("posts a note and deletes one", async () => {
    const http = answerCloudHttp((request) =>
      request.method === "DELETE" ? { status: 204 } : { status: 201, json: { id: "n1" } },
    );

    await expect(addCloudIncidentNote(ORG, INCIDENT, { body: "paged" })).resolves.toEqual({
      id: "n1",
    });
    await expect(deleteCloudIncidentNote(ORG, INCIDENT, "n 1")).resolves.toBeUndefined();

    expect(http.mock.calls.map(([request]) => request)).toEqual([
      {
        method: "POST",
        url: `/api/org/${ORG}/incidents/${INCIDENT}/notes`,
        body: JSON.stringify({ body: "paged" }),
      },
      { method: "DELETE", url: `/api/org/${ORG}/incidents/${INCIDENT}/notes/n%201` },
    ]);
  });

  it("retries the failed artefacts with no body", async () => {
    const http = answerCloudHttp(() => ({ status: 200, json: { id: INCIDENT } }));

    await retryCloudIncidentArtifacts(ORG, INCIDENT);

    expect(http).toHaveBeenCalledWith({
      method: "POST",
      url: `/api/org/${ORG}/incidents/${INCIDENT}/retry-artifacts`,
    });
  });
});

describe("paging incidents", () => {
  it("asks for resolved ones only for `all`", async () => {
    const http = answerCloudHttp(() => ({ status: 200, json: { incidents: [] } }));

    await listCloudPagerIncidents(ORG, "open");
    await listCloudPagerIncidents(ORG, "all");

    expect(http.mock.calls.map(([request]) => request.url)).toEqual([
      `/api/org/${ORG}/paging-incidents`,
      `/api/org/${ORG}/paging-incidents?status=all`,
    ]);
  });

  it("acknowledges and resolves upstream", async () => {
    const http = answerCloudHttp(() => ({ status: 200, json: { id: "p1" } }));

    await actOnCloudPagerIncident(ORG, "p1", "acknowledge");
    await actOnCloudPagerIncident(ORG, "p1", "resolve");

    expect(http.mock.calls.map(([request]) => request)).toEqual([
      { method: "POST", url: `/api/org/${ORG}/paging-incidents/p1/acknowledge` },
      { method: "POST", url: `/api/org/${ORG}/paging-incidents/p1/resolve` },
    ]);
  });

  it("refuses an unknown action before sending anything", async () => {
    const http = answerCloudHttp(() => ({ status: 200, json: {} }));
    // A caller outside the type, which the check exists for: a method's
    // parameters are compared bivariantly, so this view takes any string.
    const untyped: { act(orgId: string, id: string, action: string): Promise<unknown> } = {
      act: actOnCloudPagerIncident,
    };

    await expect(untyped.act(ORG, "p1", "escalate")).rejects.toThrow(
      'Unknown paging incident action "escalate"',
    );
    expect(http).not.toHaveBeenCalled();
  });
});
