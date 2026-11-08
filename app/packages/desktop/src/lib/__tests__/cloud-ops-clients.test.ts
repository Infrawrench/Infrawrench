/**
 * The renderer clients of the operations areas on the cloud transport
 * (changes, IaC, schedules, leases, DORA, metric alerts, runbooks, backups,
 * query monitors, savings findings, network flow reports, status pages, log
 * workspaces, custom graphs), against a fake `CloudHttp`: what each call
 * sends where the wrapper shapes the request, and what the panel gets back
 * where the wrapper reshapes the answer or the error.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../rpc/client", async () => (await import("./fake-rpc")).fakeRpcClientModule);
vi.mock("../rpc/desktop-client", async () => (await import("./fake-rpc")).fakeRpcClientModule);

let activeCloudOrgId: string | null = "org-1";
vi.mock("@infrawrench/ui", () => ({
  useUIStore: { getState: () => ({ activeCloudOrgId }) },
}));

const { answerCloudHttp, resetFakeRpc } = await import("./fake-rpc");
const { createDesktopChangesClient } = await import("../changes-client");
const { createDesktopSchedulesClient } = await import("../schedules-client");
const { createDesktopLeasesClient } = await import("../leases-client");
const { createDesktopDoraClient } = await import("../dora-client");
const { createDesktopSavingsFindingsClient } = await import("../savings-findings-client");
const { createDesktopNetworkFlowReportsClient } = await import("../network-flow-reports-client");
const { createCloudCustomGraphsClient } = await import("../cloud-custom-graphs");
const { previewCloudMetricAlertSelector, listCloudMetricAlertEvents } =
  await import("../cloud-metric-alerts");
const {
  fetchCloudBackupPolicies,
  fetchCloudRestoreDrills,
  fetchCloudRunbookRuns,
  startCloudRunbookRun,
  updateCloudRunbook,
} = await import("../cloud-resources");

const RULE_ID = "6f1c2b9e-3c7a-4f5e-9a51-0d2e7b8c4a10";

beforeEach(() => {
  resetFakeRpc();
  activeCloudOrgId = "org-1";
});

describe("the changes client", () => {
  it("reads a feed page with its filters and puts absent diff values back", async () => {
    const http = answerCloudHttp(() => ({
      status: 200,
      json: {
        entries: [{ id: "c1", diff: [{ field: "size", to: "large" }] }],
        total: 1,
        page: 2,
        pageSize: 50,
      },
    }));

    const page = await createDesktopChangesClient().listChanges({
      page: 2,
      pageSize: 50,
      kind: "updated",
    });

    expect(http).toHaveBeenCalledWith({
      method: "GET",
      url: "/api/org/org-1/changes?page=2&pageSize=50&kind=updated",
    });
    expect(page.entries[0]?.diff[0]).toEqual({ field: "size", from: undefined, to: "large" });
  });

  it("pins a change's cost impact through the cost annotations route", async () => {
    const http = answerCloudHttp(() => ({ status: 200, json: { annotationId: "a1" } }));

    await createDesktopChangesClient().annotateCostImpact?.("c1");

    expect(http).toHaveBeenCalledWith({
      method: "POST",
      url: "/api/org/org-1/cost-annotations/change-impact",
      body: JSON.stringify({ subjectKind: "change", subjectId: "c1" }),
    });
  });

  it("previews and applies a revert on the same path", async () => {
    const plan = { fields: [{ field: "size", status: "revertible", reason: "" }] };
    const http = answerCloudHttp(() => ({ status: 200, json: { changeId: "c1", plan } }));
    const revert = createDesktopChangesClient().revert;

    const preview = await revert?.preview("c1");
    await revert?.apply("c1");

    expect(http.mock.calls.map(([request]) => request)).toEqual([
      { method: "GET", url: "/api/org/org-1/changes/c1/revert" },
      { method: "POST", url: "/api/org/org-1/changes/c1/revert" },
    ]);
    expect(preview?.plan.fields[0]).toHaveProperty("revertTo", undefined);
  });

  it("refuses outside cloud mode with the panel's sentence", () => {
    activeCloudOrgId = null;
    expect(() => createDesktopChangesClient().listChanges({ page: 1, pageSize: 50 })).toThrow(
      "The change timeline requires cloud mode: sign in to sync.",
    );
  });
});

describe("the schedules client", () => {
  it("reads a schedule without remediation as having none", async () => {
    answerCloudHttp(() => ({
      status: 200,
      json: { schedules: [{ id: "s1", remediation: null }] },
    }));

    const { schedules } = await createDesktopSchedulesClient().listSchedules();

    expect(schedules[0]).toEqual({ id: "s1" });
  });
});

describe("the leases client", () => {
  it("reads one resource's lease by query", async () => {
    const http = answerCloudHttp(() => ({ status: 200, json: { lease: null } }));

    await expect(createDesktopLeasesClient().getResourceLease("acc:t:r 1")).resolves.toBeNull();
    expect(http).toHaveBeenCalledWith({
      method: "GET",
      url: "/api/org/org-1/leases/resource?resourceId=acc%3At%3Ar+1",
    });
  });
});

describe("the DORA client", () => {
  const window = { from: "2026-10-01T00:00:00.000Z", to: "2026-11-01T00:00:00.000Z" };

  it("sends the report's breakdown and the scope value only with a dimension", async () => {
    const http = answerCloudHttp(() => ({ status: 200, json: {} }));
    const dora = createDesktopDoraClient();

    await dora.getReport({ ...window, value: "orphan", groupBy: "service", bucket: "week" });
    await dora.listChanges({ ...window, dimension: "service", value: "api", failedOnly: true });

    expect(http.mock.calls.map(([request]) => request.url)).toEqual([
      "/api/org/org-1/dora?from=2026-10-01T00%3A00%3A00.000Z&to=2026-11-01T00%3A00%3A00.000Z&bucket=week&groupBy=service",
      "/api/org/org-1/dora/changes?from=2026-10-01T00%3A00%3A00.000Z&to=2026-11-01T00%3A00%3A00.000Z&dimension=service&value=api&failedOnly=true",
    ]);
  });
});

describe("the metric alerts client", () => {
  it("leaves the selector's empty parts out of the preview query", async () => {
    const http = answerCloudHttp(() => ({ status: 200, json: { count: 0, sample: [] } }));

    await previewCloudMetricAlertSelector("org-1", {
      pluginId: "aws",
      resourceTypeId: null,
      tagKey: "env",
      tagValue: "",
    });

    expect(http).toHaveBeenCalledWith({
      method: "GET",
      url: "/api/org/org-1/metric-alerts/selector-preview?pluginId=aws&tagKey=env",
    });
  });

  it("narrows the events to one rule", async () => {
    const http = answerCloudHttp(() => ({ status: 200, json: [] }));

    await listCloudMetricAlertEvents("org-1", { ruleId: RULE_ID, limit: 20 });

    expect(http).toHaveBeenCalledWith({
      method: "GET",
      url: `/api/org/org-1/metric-alerts/events?ruleId=${RULE_ID}&limit=20`,
    });
  });
});

describe("runbooks and backups", () => {
  it("reads the last 50 runs", async () => {
    const http = answerCloudHttp(() => ({ status: 200, json: { runs: [] } }));

    await expect(fetchCloudRunbookRuns("org-1")).resolves.toEqual([]);
    expect(http).toHaveBeenCalledWith({
      method: "GET",
      url: "/api/org/org-1/runbooks/runs?limit=50",
    });
  });

  it("starts a run with an empty body and edits only the step fields that are set", async () => {
    const http = answerCloudHttp(() => ({ status: 200, json: {} }));

    await startCloudRunbookRun("org-1", RULE_ID);
    await updateCloudRunbook("org-1", RULE_ID, {
      steps: [{ id: undefined, kind: "manual", title: "Fail over", body: undefined }],
    });

    expect(http.mock.calls.map(([request]) => request)).toEqual([
      { method: "POST", url: `/api/org/org-1/runbooks/${RULE_ID}/runs`, body: "{}" },
      {
        method: "PATCH",
        url: `/api/org/org-1/runbooks/${RULE_ID}`,
        body: JSON.stringify({ steps: [{ kind: "manual", title: "Fail over" }] }),
      },
    ]);
  });

  it("unwraps the backup policies and reads the drill standings", async () => {
    const http = answerCloudHttp((request) => ({
      status: 200,
      json: request.url.endsWith("/policies") ? { policies: [{ id: "p1" }] } : { resources: [] },
    }));

    await expect(fetchCloudBackupPolicies("org-1")).resolves.toEqual([{ id: "p1" }]);
    await fetchCloudRestoreDrills("org-1");

    expect(http.mock.calls[1]?.[0]).toEqual({
      method: "GET",
      url: "/api/org/org-1/backups/drills",
    });
  });
});

describe("the savings findings client", () => {
  it("asks for a refresh only when told to", async () => {
    const http = answerCloudHttp(() => ({ status: 200, json: { findings: [] } }));
    const client = createDesktopSavingsFindingsClient();

    await client.listFindings();
    await client.listFindings({ refresh: true });

    expect(http.mock.calls.map(([request]) => request.url)).toEqual([
      "/api/org/org-1/savings/findings",
      "/api/org/org-1/savings/findings?refresh=true",
    ]);
  });

  it("shows the server's sentence rather than the transport's", async () => {
    answerCloudHttp(() => ({ status: 409, json: { error: "A view with that name exists" } }));

    const { createView } = createDesktopSavingsFindingsClient();
    if (!createView) throw new Error("the desktop client has no createView");
    await expect(
      createView({
        name: "Mine",
        description: undefined,
        status: "open",
        filter: { kinds: undefined },
        sort: { field: "savings", direction: "desc" },
      }),
    ).rejects.toThrow(/^A view with that name exists$/);
  });

  it("keeps the transport's message when the body names no error", async () => {
    answerCloudHttp(() => ({ status: 502, json: ["upstream"] }));

    await expect(createDesktopSavingsFindingsClient().listViews()).rejects.toThrow(
      'Cloud request failed: 502 /savings-views ["upstream"]',
    );
  });
});

describe("network flow reports, custom graphs", () => {
  it("runs a saved report without a body", async () => {
    const http = answerCloudHttp(() => ({ status: 200, json: { rows: [] } }));

    await createDesktopNetworkFlowReportsClient().runReport("r1");

    expect(http).toHaveBeenCalledWith({
      method: "POST",
      url: "/api/org/org-1/network-flows/reports/r1/run",
    });
  });

  it("sends only the render request fields that are set", async () => {
    const http = answerCloudHttp(() => ({ status: 200, json: { ok: true } }));

    await createCloudCustomGraphsClient("org-1").render("g1", {
      trigger: "manual",
      button: undefined,
    });

    expect(http).toHaveBeenCalledWith({
      method: "POST",
      url: "/api/org/org-1/custom-graphs/g1/render",
      body: JSON.stringify({ trigger: "manual" }),
    });
  });
});
