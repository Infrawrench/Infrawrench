import { describe, expect, it } from "vitest";
import { mapComponent, parseStatusFeed } from "../status-feed.js";
import { aggregateRows, mapComputeRecords, mapVolumeRecords } from "../cost-data.js";
import { runpodTerraformExport } from "../terraform.js";
import { runpodRemediationCommands } from "../remediation.js";
import { makeInstance } from "../mappers.js";

const doc = {
  included: [
    { id: "1", type: "status_page_resource", attributes: { public_name: "US-MO-1 " } },
    {
      id: "2",
      type: "status_page_resource",
      attributes: { public_name: "serverless: queue engine" },
    },
    {
      id: "3",
      type: "status_page_resource",
      attributes: { public_name: "graphql: api.runpod.io" },
    },
    {
      id: "10",
      type: "status_report",
      attributes: {
        title: "US-MO-1 Network Issue",
        report_type: "manual",
        starts_at: "2026-10-01T10:00:00.000Z",
        affected_resources: [{ status_page_resource_id: "1", status: "downtime" }],
        aggregate_state: "downtime",
      },
      relationships: { status_updates: { data: [{ id: "u1" }, { id: "u2" }] } },
    },
    {
      id: "11",
      type: "status_report",
      attributes: {
        title: "API errors",
        report_type: "manual",
        starts_at: "2026-10-01T10:00:00.000Z",
        affected_resources: [
          { status_page_resource_id: "2", status: "degraded" },
          { status_page_resource_id: "3", status: "degraded" },
        ],
        aggregate_state: "degraded",
      },
    },
    {
      id: "12",
      type: "status_report",
      attributes: { title: "old", aggregate_state: "resolved", affected_resources: [] },
    },
    {
      id: "13",
      type: "status_report",
      attributes: {
        title: "Future maintenance",
        report_type: "maintenance",
        starts_at: "2999-01-01T00:00:00.000Z",
        aggregate_state: "maintenance",
        affected_resources: [{ status_page_resource_id: "1", status: "maintenance" }],
      },
    },
    {
      id: "u1",
      type: "status_update",
      attributes: { message: "<p>Looking</p>", published_at: "2026-10-01T10:05:00Z" },
    },
    {
      id: "u2",
      type: "status_update",
      attributes: { message: "Fix applied", published_at: "2026-10-01T11:00:00Z" },
    },
  ],
};

describe("status feed", () => {
  it("maps data center components to regions and APIs to provider-wide", () => {
    expect(mapComponent("EUR-IS-1")).toEqual({ region: "EUR-IS-1" });
    expect(mapComponent("ui: runpod.io/console").providerWide).toBe(true);
    expect(mapComponent("pod proxy: proxy.runpod.net").resourceTypes).toEqual(["pod"]);
  });

  it("returns only active, started incidents", () => {
    const out = parseStatusFeed(JSON.stringify(doc));
    expect(out.map((i) => i.externalId)).toEqual(["10", "11"]);
    expect(out[0]).toMatchObject({
      regions: ["US-MO-1"],
      impact: "major",
      lastUpdateText: "Fix applied",
      providerWide: false,
      url: "https://uptime.runpod.io/incident/10",
    });
    expect(out[1]).toMatchObject({
      providerWide: true,
      resourceTypes: ["serverless-endpoint"],
      impact: "minor",
    });
  });

  it("rejects a non-status document", () => {
    expect(() => parseStatusFeed("{}")).toThrow();
  });
});

describe("cost data", () => {
  const range = { fromDate: "2026-09-01", toDate: "2026-09-30" };
  const ctx = { regions: new Map([["pod1", "EU-RO-1"]]), names: new Map([["pod1", "trainer"]]) };

  it("maps pod billing records with region, name and hours", () => {
    const rows = mapComputeRecords(
      [
        { podId: "pod1", amount: 1.5, time: "2026-09-02T00:00:00Z", timeBilledMs: 7_200_000 },
        { podId: "gone", amount: 0.5, time: "2026-09-02T00:00:00Z" },
        { podId: "pod1", amount: 9, time: "2026-08-31T00:00:00Z" },
        { podId: "pod1", amount: 0, time: "2026-09-03T00:00:00Z" },
      ],
      "Pods",
      "podId",
      range,
      ctx,
    );
    expect(rows).toEqual([
      {
        date: "2026-09-02",
        service: "Pods",
        region: "EU-RO-1",
        resourceId: "pod1",
        tags: { resource_name: "trainer" },
        currency: "USD",
        amount: 1.5,
        usageAmount: 2,
        usageUnit: "hours",
      },
      { date: "2026-09-02", service: "Pods", resourceId: "gone", currency: "USD", amount: 0.5 },
    ]);
  });

  it("splits standard and high-performance network storage", () => {
    const rows = mapVolumeRecords(
      [
        {
          time: "2026-09-05T00:00:00Z",
          amount: 0.2,
          diskSpaceBilledGb: 100,
          highPerformanceStorageAmount: 0.1,
          highPerformanceStorageDiskSpaceBilledGb: 10,
        },
      ],
      range,
    );
    expect(rows.map((r) => [r.service, r.amount, r.usageAmount])).toEqual([
      ["Network Volumes", 0.2, 100],
      ["High Performance Storage", 0.1, 10],
    ]);
  });

  it("sums rows that share a key", () => {
    const rows = aggregateRows([
      { date: "2026-09-01", service: "Pods", currency: "USD", amount: 0.1 },
      { date: "2026-09-01", service: "Pods", currency: "USD", amount: 0.2 },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.amount).toBeCloseTo(0.3, 6);
  });
});

describe("terraform", () => {
  it("exports a network volume and a template without an import id", () => {
    const vol = makeInstance({
      accountId: "a",
      typeId: "network-volume",
      externalId: "vol1",
      displayName: "data",
      fields: { name: "data", sizeGb: 100, region: "EU-RO-1", attachedTo: "" },
    });
    const out = runpodTerraformExport.mapResource(vol)!;
    expect(out.resource.type).toBe("runpod_network_volume");
    expect(out.resource.importId).toBeUndefined();
    expect(out.resource.attributes["data_center_id"]).toEqual({ kind: "string", value: "EU-RO-1" });

    const tpl = makeInstance({
      accountId: "a",
      typeId: "template",
      externalId: "t1",
      displayName: "worker",
      fields: { name: "worker", imageName: "img", isServerless: true, ports: "8000/http" },
    });
    const t = runpodTerraformExport.mapResource(tpl)!;
    expect(t.resource.attributes["is_serverless"]).toEqual({ kind: "bool", value: true });
    expect(t.resource.attributes["ports"]).toEqual({
      kind: "list",
      items: [{ kind: "string", value: "8000/http" }],
    });
  });

  it("keeps registry passwords in a sensitive variable", () => {
    const auth = makeInstance({
      accountId: "a",
      typeId: "container-registry-auth",
      externalId: "clz1",
      displayName: "ghcr",
      fields: { name: "ghcr" },
    });
    const out = runpodTerraformExport.mapResource(auth)!;
    expect(out.resource.attributes["password"]).toEqual({
      kind: "ref",
      expr: "var.runpod_registry_password_clz1",
    });
    expect(out.variables?.find((v) => v.sensitive)?.name).toBe("runpod_registry_password_clz1");
  });
});

describe("remediation", () => {
  it("offers stop/start for a sleep schedule and delete for orphans", () => {
    const resource = { resourceTypeId: "pod", externalId: "pod1", fields: {} } as never;
    expect(
      runpodRemediationCommands({ kind: "sleep-schedule", resource } as never).map(
        (c) => c.command,
      ),
    ).toEqual(["runpodctl pod stop pod1", "runpodctl pod start pod1"]);
    expect(runpodRemediationCommands({ kind: "orphan", resource } as never)[0]!.command).toBe(
      "runpodctl pod delete pod1",
    );
  });
});
