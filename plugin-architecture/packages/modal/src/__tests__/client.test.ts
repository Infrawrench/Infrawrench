import { describe, expect, it } from "vitest";
import { ModalClient } from "../client.js";
import { plugin } from "../plugin.js";
import { ProtoWriter } from "../proto.js";
import { parseStatusFeed } from "../status-feed.js";
import { makeHttp, withMap } from "./helpers.js";

const ACCOUNT = "acct";

function environment(id: string, name: string, extra: (w: ProtoWriter) => ProtoWriter = (w) => w) {
  return extra(new ProtoWriter().string(1, name).string(6, id).double(3, 1_700_000_000));
}

function route(method: string, request: import("../proto.js").ProtoMessage) {
  switch (method) {
    case "EnvironmentList":
      return new ProtoWriter()
        .message(
          2,
          environment("en-1", "main", (w) =>
            w.int(4, true).int(7, 10, true).int(9, 4).double(12, 100).double(13, 25),
          ),
        )
        .message(2, environment("en-2", "dev"));
    case "AppList": {
      const env = request.string(1);
      if (env !== "main") return new ProtoWriter();
      return new ProtoWriter()
        .message(
          1,
          new ProtoWriter()
            .string(1, "ap-live")
            .string(3, "inference")
            .int(4, 3)
            .double(5, 1_700_000_000)
            .int(8, 2)
            .string(10, "inference")
            .message(11, new ProtoWriter().string(3, "main")),
        )
        .message(
          1,
          new ProtoWriter().string(1, "ap-old").string(3, "batch").int(4, 5).string(10, "batch"),
        );
    }
    case "AppGetInfo": {
      const info = withMap(
        new ProtoWriter().string(1, "inference").string(2, "ap-live").string(3, "main"),
        5,
        { predict: "fu-predict", nightly: "fu-nightly" },
      );
      return new ProtoWriter()
        .message(1, info)
        .message(
          2,
          new ProtoWriter()
            .string(1, "fu-predict")
            .message(
              2,
              new ProtoWriter().message(1, new ProtoWriter().int(2, 2).string(4, "H100")),
            ),
        )
        .message(
          2,
          new ProtoWriter()
            .string(1, "fu-nightly")
            .message(
              2,
              new ProtoWriter().message(
                2,
                new ProtoWriter().message(1, new ProtoWriter().string(1, "0 3 * * *")),
              ),
            ),
        );
    }
    case "AppStop":
      return new ProtoWriter();
    case "FunctionGetById": {
      const fn = new ProtoWriter()
        .message(
          9,
          new ProtoWriter()
            .int(2, 16384)
            .int(3, 4000)
            .message(4, new ProtoWriter().int(2, 2).string(4, "H100")),
        )
        .int(34, 8);
      const data = new ProtoWriter()
        .string(1, "app")
        .string(2, "predict")
        .int(8, 600)
        .message(18, new ProtoWriter().int(1, 0).message(2, fn))
        .message(31, new ProtoWriter().int(1, 1, true).int(2, 20, true).int(5, 300, true));
      return new ProtoWriter().message(1, data).message(2, new ProtoWriter().string(52, "ap-live"));
    }
    case "FunctionGetCurrentStats":
      return new ProtoWriter().int(1, 3).int(3, 2).int(4, 5);
    case "SecretList":
      return request.string(1) === "main"
        ? new ProtoWriter().message(
            1,
            new ProtoWriter()
              .string(5, "st-1")
              .message(6, new ProtoWriter().string(1, "openai").strings(3, ["OPENAI_API_KEY"])),
          )
        : new ProtoWriter();
    default:
      return new ProtoWriter();
  }
}

function client() {
  const { http, calls } = makeHttp(route);
  return { c: new ModalClient({ tokenId: "ak-x", tokenSecret: "as-y" }, { http }), calls };
}

describe("ModalClient listing", () => {
  it("lists environments with their limits and spend", async () => {
    const { c } = client();
    const envs = await c.listResources("environment", ACCOUNT);
    expect(envs.map((e) => e.id)).toEqual(["acct:environment:en-1", "acct:environment:en-2"]);
    expect(envs[0]?.fields).toMatchObject({
      name: "main",
      isDefault: true,
      maxConcurrentTasks: 10,
      currentConcurrentTasks: 4,
      spendLimit: 100,
      cycleUsage: 25,
    });
  });

  it("lists apps across every environment", async () => {
    const { c, calls } = client();
    const apps = await c.listResources("app", ACCOUNT);
    expect(apps.map((a) => [a.externalId, a.fields["state"]])).toEqual([
      ["ap-live", "deployed"],
      ["ap-old", "stopped"],
    ]);
    expect(calls.filter((x) => x.method === "AppList").map((x) => x.request.string(1))).toEqual([
      "main",
      "dev",
    ]);
  });

  it("lists functions of deployed apps only, with GPUs and schedules", async () => {
    const { c, calls } = client();
    const fns = await c.listResources("function", ACCOUNT);
    expect(fns.map((f) => [f.displayName, f.fields["gpu"], f.fields["schedule"]])).toEqual([
      ["inference.nightly", undefined, "cron 0 3 * * * (UTC)"],
      ["inference.predict", "2 x H100", undefined],
    ]);
    expect(calls.filter((x) => x.method === "AppGetInfo")).toHaveLength(1);
    const scheduled = await c.listResources("scheduled-function", ACCOUNT);
    expect(scheduled.map((f) => f.externalId)).toEqual(["fu-nightly"]);
  });

  it("reads one function without listing every app", async () => {
    const { c, calls } = client();
    const fn = await c.getResource("function", "acct:function:fu-predict", ACCOUNT);
    expect(fn.displayName).toBe("inference.predict");
    expect(fn.fields["gpu"]).toBe("2 x H100");
    expect(calls.some((x) => x.method === "AppList")).toBe(false);
    const detail = JSON.parse(fn.resolvedOutputs["__function__"]!);
    expect(detail).toMatchObject({
      appId: "ap-live",
      minContainers: 1,
      maxContainers: 20,
      scaledownWindowSecs: 300,
      timeoutSecs: 600,
    });
    expect(detail.hardware[0]).toMatchObject({
      gpus: [{ type: "H100", count: 2 }],
      milliCpu: 4000,
      memoryMb: 16384,
      maxConcurrentInputs: 8,
    });
    expect(JSON.parse(fn.resolvedOutputs["__stats__"]!)).toEqual({
      backlog: 3,
      totalTasks: 2,
      runningInputs: 5,
      inputHeadroom: 0,
    });
    const schema = c.renderDetail(fn);
    expect(schema.metricsCapability).toBeDefined();
  });

  it("lists secret names and key names only", async () => {
    const { c } = client();
    const [secret] = await c.listResources("secret", ACCOUNT);
    expect(secret?.fields).toMatchObject({ name: "openai", keys: "OPENAI_API_KEY", keyCount: 1 });
  });

  it("stops an app by id", async () => {
    const { c, calls } = client();
    await c.invokeAction("app", "acct:app:ap-live", "stop", ACCOUNT);
    expect(calls.find((x) => x.method === "AppStop")?.request.string(1)).toBe("ap-live");
  });

  it("reports environment caps and spend limits as quotas", async () => {
    const { c } = client();
    const quotas = await c.fetchQuotas(ACCOUNT);
    expect(quotas.map((q) => [q.id, q.used, q.limit])).toEqual([
      ["en-1:concurrent-containers", 4, 10],
      ["en-1:cycle-spend", 25, 100],
    ]);
  });

  it("offers Stop only on an app that is running", () => {
    const { c } = client();
    const stopIds = (state: string) =>
      (
        c.renderDetail({
          id: "acct:app:ap-1",
          pluginId: "modal",
          resourceTypeId: "app",
          accountId: ACCOUNT,
          displayName: "x",
          fields: { state },
          resolvedOutputs: {},
          secretStates: [],
          createdAt: "",
          updatedAt: "",
        }).headerActions ?? []
      )
        .map((a) => (a.action.type === "plugin-action" ? a.action.actionId : ""))
        .filter(Boolean);
    expect(stopIds("deployed")).toEqual(["stop"]);
    expect(stopIds("stopped")).toEqual([]);
  });

  it("refuses to clear a concurrency cap the API cannot remove", async () => {
    const { c } = client();
    await expect(
      c.updateResource("environment", "acct:environment:en-1", ACCOUNT, { maxConcurrentTasks: "" }),
    ).rejects.toThrow(/cannot remove a concurrency cap/);
  });
});

describe("status feed", () => {
  it("returns unresolved reports scoped to the components they affect", () => {
    const body = JSON.stringify({
      included: [
        { id: "1", type: "status_page_resource", attributes: { public_name: "Functions" } },
        { id: "2", type: "status_page_resource", attributes: { public_name: "Dashboard" } },
        {
          id: "u1",
          type: "status_update",
          attributes: { message: "Investigating", published_at: "2026-10-04T10:00:00Z" },
        },
        {
          id: "r1",
          type: "status_report",
          attributes: {
            title: "Function latency",
            report_type: "manual",
            starts_at: "2026-10-04T09:55:00Z",
            aggregate_state: "degraded",
            affected_resources: [
              { status_page_resource_id: "1", status: "degraded" },
              { status_page_resource_id: "2", status: "downtime" },
            ],
          },
          relationships: { status_updates: { data: [{ id: "u1" }] } },
        },
        {
          id: "r0",
          type: "status_report",
          attributes: { title: "Old", aggregate_state: "resolved", affected_resources: [] },
        },
      ],
    });
    const incidents = parseStatusFeed(body);
    expect(incidents).toHaveLength(1);
    expect(incidents[0]).toMatchObject({
      externalId: "r1",
      impact: "major",
      services: ["Functions", "Dashboard"],
      resourceTypes: ["function", "scheduled-function"],
      lastUpdateText: "Investigating",
      providerWide: false,
    });
  });
});

describe("manifest", () => {
  it("declares costs, quotas and the status feed", () => {
    expect(plugin.manifest.costs?.dimensions).toEqual(["service", "resource", "tag"]);
    expect(plugin.manifest.quotas).toBeDefined();
    expect(plugin.manifest.statusFeed?.url).toBe("https://status.modal.com/index.json");
  });
});
