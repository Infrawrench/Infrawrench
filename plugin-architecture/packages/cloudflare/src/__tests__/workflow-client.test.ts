import { describe, it, expect, vi, afterEach } from "vitest";
import {
  listWorkflows,
  getWorkflow,
  deleteWorkflow,
  listRecentInstances,
  triggerInstance,
  changeInstanceStatus,
  actionsForStatus,
} from "../clients/workflow-client.js";
import { CloudflareClient } from "../client.js";
import { plugin } from "../plugin.js";
import { makeApi, asyncIter } from "./_helpers.js";

const WORKFLOW = {
  id: "wf-uuid",
  name: "order-pipeline",
  class_name: "OrderPipeline",
  script_name: "orders-worker",
  created_on: "2026-01-01T00:00:00Z",
  modified_on: "2026-01-02T00:00:00Z",
  triggered_on: "2026-01-03T00:00:00Z",
  instances: { running: 2, queued: 1, waiting: 1, waitingForPause: 1, errored: 3, complete: 40 },
  schedules: [
    { cron: "0 * * * *", next_instance: "2026-01-03T02:00:00Z" },
    { cron: "*/30 * * * *", next_instance: "2026-01-03T01:30:00Z" },
  ],
};

const INSTANCES = [
  {
    id: "inst-1",
    status: "running",
    trigger_source: "api",
    created_on: "2026-01-03T00:00:00Z",
    started_on: "2026-01-03T00:00:01Z",
    ended_on: null,
    modified_on: "2026-01-03T00:00:02Z",
    version_id: "v1",
    workflow_id: "wf-uuid",
  },
  {
    id: "inst-2",
    status: "errored",
    trigger_source: "cron",
    created_on: "2026-01-02T00:00:00Z",
    started_on: "2026-01-02T00:00:01Z",
    ended_on: "2026-01-02T00:01:00Z",
    modified_on: "2026-01-02T00:01:00Z",
    version_id: "v1",
    workflow_id: "wf-uuid",
  },
];

function wfApi() {
  const workflows = {
    list: vi.fn(() => asyncIter([WORKFLOW])),
    get: vi.fn(async () => WORKFLOW),
    delete: vi.fn(async () => ({ status: "ok", success: true })),
    instances: {
      list: vi.fn(() => asyncIter(INSTANCES)),
      create: vi.fn(async () => ({ id: "inst-new", status: "queued" })),
      status: { edit: vi.fn(async () => ({ status: "paused", timestamp: "t" })) },
    },
  };
  return makeApi({ cf: { workflows } });
}

describe("workflow-client", () => {
  it("listWorkflows maps counts, schedules and outputs", async () => {
    const api = wfApi();
    const [wf] = await listWorkflows(api, "acct");
    expect(wf!.id).toBe("acct:workflow:order-pipeline");
    expect(wf!.externalId).toBe("order-pipeline");
    expect(wf!.fields.className).toBe("OrderPipeline");
    expect(wf!.fields.scriptName).toBe("orders-worker");
    expect(wf!.fields.running).toBe(2);
    expect(wf!.fields.waiting).toBe(2);
    expect(wf!.fields.errored).toBe(3);
    expect(wf!.fields.terminated).toBe(0);
    expect(wf!.fields.schedules).toBe("0 * * * *, */30 * * * *");
    expect(wf!.fields.nextScheduledRun).toBe("2026-01-03T01:30:00Z");
    expect(wf!.resolvedOutputs.workflowName).toBe("order-pipeline");
  });

  it("listWorkflows surfaces a Workers Scripts permission hint on a 403", async () => {
    const api = makeApi({
      cf: {
        workflows: {
          list: vi.fn(() => {
            throw { status: 403 };
          }),
        },
      },
    });
    await expect(listWorkflows(api, "acct")).rejects.toThrow(/Workers Scripts:Read/);
  });

  it("getWorkflow / deleteWorkflow address the workflow by name", async () => {
    const api = wfApi();
    const wf = await getWorkflow(api, "order-pipeline", "acct");
    expect(wf.displayName).toBe("order-pipeline");
    await deleteWorkflow(api, "order-pipeline");
    expect(api.cf.workflows.delete).toHaveBeenCalledWith("order-pipeline", {
      account_id: "acct-cf",
    });
  });

  it("listRecentInstances asks newest-first and stops at the limit", async () => {
    const api = wfApi();
    const { instances, truncated } = await listRecentInstances(api, "order-pipeline", 1);
    expect(api.cf.workflows.instances.list).toHaveBeenCalledWith("order-pipeline", {
      account_id: "acct-cf",
      per_page: 1,
      direction: "desc",
    });
    expect(instances).toHaveLength(1);
    expect(instances[0]).toMatchObject({ id: "inst-1", status: "running", triggerSource: "api" });
    expect(instances[0]!.endedOn).toBe("");
    expect(truncated).toBe(true);
  });

  it("triggerInstance creates an instance with no params", async () => {
    const api = wfApi();
    expect(await triggerInstance(api, "order-pipeline")).toBe("inst-new");
    expect(api.cf.workflows.instances.create).toHaveBeenCalledWith("order-pipeline", {
      account_id: "acct-cf",
    });
  });

  it("changeInstanceStatus patches the instance status", async () => {
    const api = wfApi();
    await changeInstanceStatus(api, "order-pipeline", "inst-1", "pause");
    expect(api.cf.workflows.instances.status.edit).toHaveBeenCalledWith(
      "order-pipeline",
      "inst-1",
      { account_id: "acct-cf", status: "pause" },
    );
  });

  it("actionsForStatus only offers valid transitions", () => {
    expect(actionsForStatus("running")).toEqual(["pause", "terminate", "restart"]);
    expect(actionsForStatus("paused")).toEqual(["resume", "terminate", "restart"]);
    expect(actionsForStatus("complete")).toEqual(["restart"]);
    expect(actionsForStatus("rollingBack")).toEqual([]);
  });
});

describe("CloudflareClient workflow wiring", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  function client() {
    const c = new CloudflareClient({ apiToken: "tok" }, plugin.resourceTypes);
    const api = wfApi();
    (c as unknown as { api: unknown }).api = api;
    return { c, api };
  }

  it("enrichDetail stashes recent instances and renderDetail builds row actions", async () => {
    const { c } = client();
    const wf = await c.getResource("workflow", "acct:workflow:order-pipeline", "acct");
    const enriched = await c.enrichDetail(wf);
    expect(JSON.parse(enriched.resolvedOutputs["__instances__"]!)).toHaveLength(2);
    const schema = c.renderDetail(enriched);
    expect(schema.status).toMatchObject({ status: "degraded" });
    expect(schema.metricsCapability).toBeTruthy();
    const json = JSON.stringify(schema);
    expect(json).toContain("instance-pause:inst-1");
    expect(json).toContain("instance-restart:inst-2");
    expect(json).not.toContain("instance-resume:inst-1");
    expect(json).toContain("trigger-instance");
  });

  it("invokeAction routes trigger and per-instance lifecycle actions", async () => {
    const { c, api } = client();
    await c.invokeAction("workflow", "acct:workflow:order-pipeline", "trigger-instance", "acct");
    expect(api.cf.workflows.instances.create).toHaveBeenCalled();
    await c.invokeAction(
      "workflow",
      "acct:workflow:order-pipeline",
      "instance-terminate:id:with:colons",
      "acct",
    );
    expect(api.cf.workflows.instances.status.edit).toHaveBeenCalledWith(
      "order-pipeline",
      "id:with:colons",
      { account_id: "acct-cf", status: "terminate" },
    );
    await expect(
      c.invokeAction("workflow", "acct:workflow:order-pipeline", "instance-explode:x", "acct"),
    ).rejects.toThrow(/unknown action/);
  });

  it("deleteResource and resolveOutput cover workflows", async () => {
    const { c, api } = client();
    expect(
      await c.resolveOutput("workflow", "acct:workflow:order-pipeline", "workflowName", "acct"),
    ).toBe("order-pipeline");
    await c.deleteResource("workflow", "acct:workflow:order-pipeline", "acct");
    expect(api.cf.workflows.delete).toHaveBeenCalled();
  });

  it("fetchMetricSeries groups workflowsAdaptiveGroups by event type", async () => {
    const { c } = client();
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        data: {
          viewer: {
            accounts: [
              {
                workflowsAdaptiveGroups: [
                  {
                    count: 4,
                    dimensions: { ts: "2026-01-01T00:00:00Z", eventType: "WORKFLOW_START" },
                  },
                  {
                    count: 1,
                    dimensions: { ts: "2026-01-01T00:00:00Z", eventType: "STEP_FAILURE" },
                  },
                  {
                    count: 3,
                    dimensions: { ts: "2026-01-01T01:00:00Z", eventType: "WORKFLOW_START" },
                  },
                  {
                    count: 9,
                    dimensions: { ts: "2026-01-01T01:00:00Z", eventType: "SLEEP_START" },
                  },
                ],
              },
            ],
          },
        },
      }),
    }));
    globalThis.fetch = fetchMock as never;
    const range = { startMs: Date.now() - 48 * 3_600_000, endMs: Date.now() };
    const out = await c.fetchMetricSeries(
      "workflow",
      "acct:workflow:order-pipeline",
      "acct",
      range,
    );
    expect(out.map((s) => s.label)).toEqual(["Instances Started", "Steps Failed"]);
    expect(out[0]!.points.map((p) => p.value)).toEqual([4, 3]);
    const body = JSON.parse(
      (fetchMock.mock.calls[0] as unknown as [string, { body: string }])[1].body,
    );
    expect(body.query).toContain("workflowsAdaptiveGroups");
    expect(body.query).toContain("datetimeHour_geq");
    expect(body.variables.workflow).toBe("order-pipeline");
  });
});
