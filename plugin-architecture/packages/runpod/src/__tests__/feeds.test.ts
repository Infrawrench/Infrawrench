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
  const ctx = {
    regions: new Map([
      ["pod1", "EU-RO-1"],
      ["vol1", "US-TX-3"],
    ]),
    names: new Map([
      ["pod1", "trainer"],
      ["vol1", "data"],
    ]),
  };
  const bucket = (day: string) => ({
    startTime: `${day}T00:00:00Z`,
    endTime: `${day}T23:59:59Z`,
  });

  it("maps pod billing records with region and name", () => {
    const amounts = { gpuAmount: 0, cpuAmount: 0, diskAmount: 0 };
    const rows = mapComputeRecords(
      [
        { podId: "pod1", totalAmount: 1.5, ...amounts, ...bucket("2026-09-02") },
        { podId: "gone", totalAmount: 0.5, ...amounts, ...bucket("2026-09-02") },
        { podId: "pod1", totalAmount: 9, ...amounts, ...bucket("2026-08-31") },
        { podId: "pod1", totalAmount: 0, ...amounts, ...bucket("2026-09-03") },
      ],
      "Pods",
      (r) => r.podId,
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
      },
      { date: "2026-09-02", service: "Pods", resourceId: "gone", currency: "USD", amount: 0.5 },
    ]);
  });

  it("splits standard and high-performance network storage per volume", () => {
    const rows = mapVolumeRecords(
      [
        {
          ...bucket("2026-09-05"),
          networkVolumeId: "vol1",
          totalAmount: 0.3,
          standardAmount: 0.2,
          highPerformanceAmount: 0.1,
        },
        {
          ...bucket("2026-09-05"),
          networkVolumeId: "vol2",
          totalAmount: 0,
          standardAmount: 0,
          highPerformanceAmount: 0,
        },
      ],
      range,
      ctx,
    );
    expect(rows.map((r) => [r.service, r.resourceId, r.region, r.amount])).toEqual([
      ["Network Volumes", "vol1", "US-TX-3", 0.2],
      ["High Performance Storage", "vol1", "US-TX-3", 0.1],
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
  const str = (value: string) => ({ kind: "string", value });
  const num = (value: number) => ({ kind: "number", value });
  const instance = (
    typeId: string,
    externalId: string,
    fields: Record<string, string | number | boolean>,
  ) => makeInstance({ accountId: "a", typeId, externalId, displayName: externalId, fields });

  it("targets the provider that speaks REST v2", () => {
    expect(runpodTerraformExport.provider.version).toBe("~> 2.0");
  });

  it("exports a network volume and a template, importable by id", () => {
    const out = runpodTerraformExport.mapResource(
      instance("network-volume", "vol1", {
        name: "data",
        sizeGb: 100,
        region: "EU-RO-1",
        storageType: "STANDARD",
        attachedTo: "",
      }),
    )!;
    expect(out.resource.type).toBe("runpod_network_volume");
    expect(out.resource.importId).toBe("vol1");
    expect(out.resource.attributes).toEqual({
      name: str("data"),
      size: num(100),
      data_center: str("EU-RO-1"),
      type: str("STANDARD"),
    });

    const t = runpodTerraformExport.mapResource(
      instance("template", "t1", {
        name: "worker",
        imageName: "img",
        isServerless: true,
        ports: "8000/http",
        containerDiskGb: 20,
        volumeGb: 20,
        volumeMountPath: "/workspace",
        containerRegistryAuthId: "reg1",
      }),
    )!;
    expect(t.resource.importId).toBe("t1");
    expect(t.resource.attributes).toMatchObject({
      image: str("img"),
      serverless: { kind: "bool", value: true },
      disk: num(20),
      registry: str("reg1"),
      persistent_volume: { kind: "map", entries: { size: num(20), path: str("/workspace") } },
      ports: { kind: "list", items: [str("8000/http")] },
    });
  });

  it("exports a Serverless endpoint in the provider's new shape", () => {
    const out = runpodTerraformExport.mapResource(
      instance("serverless-endpoint", "ep1", {
        name: "llm",
        endpointType: "QUEUE",
        imageName: "img",
        gpuPools: "ADA_24, AMPERE_16",
        gpuCount: 2,
        workersMin: 0,
        workersMax: 5,
        idleTimeout: 5,
        scalerType: "QUEUE_DELAY",
        scalerValue: 4,
        flashboot: "FLASHBOOT",
        dataCenters: "US-KS-2",
        networkVolumeId: "vol1",
      }),
    )!;
    expect(out.resource.type).toBe("runpod_serverless_endpoint");
    expect(out.resource.importId).toBe("ep1");
    expect(out.resource.attributes).toMatchObject({
      endpoint_type: str("QUEUE"),
      image: str("img"),
      gpu_pools: { kind: "list", items: [str("ADA_24"), str("AMPERE_16")] },
      gpu_count: num(2),
      scaling_type: str("QUEUE_DELAY"),
      scaling_value: num(4),
      flashboot: str("FLASHBOOT"),
      network_volumes: { kind: "list", items: [str("vol1")] },
    });
  });

  it("exports a CPU endpoint's configurations", () => {
    const out = runpodTerraformExport.mapResource(
      instance("serverless-endpoint", "ep1", {
        name: "cpu",
        endpointType: "QUEUE",
        imageName: "img",
        cpuConfigs: "cpu5c:4, cpu5g:8",
        scalerType: "REQUEST_COUNT",
        scalerValue: 2,
      }),
    )!;
    expect(out.resource.attributes["cpu"]).toEqual({
      kind: "list",
      items: [
        { kind: "map", entries: { cpu_type_id: str("cpu5c"), vcpu_count: num(4) } },
        { kind: "map", entries: { cpu_type_id: str("cpu5g"), vcpu_count: num(8) } },
      ],
    });
    expect(out.resource.attributes["gpu_pools"]).toBeUndefined();
    expect(out.resource.attributes["idle_timeout"]).toBeUndefined();
  });

  it("skips an endpoint not synced since the move, which lacks what the provider requires", () => {
    expect(
      runpodTerraformExport.mapResource(
        instance("serverless-endpoint", "ep1", { name: "old", templateId: "t", flashboot: true }),
      ),
    ).toBeNull();
  });

  it("exports a pod with no spot flag, and nothing that would replace it on import", () => {
    const out = runpodTerraformExport.mapResource(
      instance("pod", "pod1", {
        name: "trainer",
        imageName: "img",
        gpuTypeId: "NVIDIA GeForce RTX 4090",
        gpuCount: 1,
        cloudType: "Community Cloud",
        containerDiskGb: 50,
        volumeGb: 20,
        volumeMountPath: "/workspace",
        ports: "8888/http, 22/tcp",
        templateId: "t1",
        interruptible: true,
        machineId: "m1",
      }),
    )!;
    expect(out.resource.importId).toBe("pod1");
    const { attributes } = out.resource;
    expect(attributes).toMatchObject({
      image: str("img"),
      gpu_type_id: str("NVIDIA GeForce RTX 4090"),
      cloud: str("COMMUNITY"),
      disk: num(50),
      ports: { kind: "list", items: [str("8888/http"), str("22/tcp")] },
    });
    for (const absent of [
      "interruptible",
      "machine_id",
      "template_id",
      "data_center_ids",
      "start_ssh",
    ]) {
      expect(attributes[absent]).toBeUndefined();
    }
  });

  it("exports a CPU pod and its network volume", () => {
    const out = runpodTerraformExport.mapResource(
      instance("pod", "pod2", {
        name: "c",
        imageName: "img",
        cpuFlavorId: "cpu5c",
        vcpus: 4,
        networkVolumeId: "vol1",
        volumeMountPath: "/data",
        additionalNetworkVolumes: "vol2",
      }),
    )!;
    expect(out.resource.attributes).toMatchObject({
      cpu_type_id: str("cpu5c"),
      vcpu_count: num(4),
      network_volumes: {
        kind: "list",
        items: [{ kind: "map", entries: { volume_id: str("vol1"), path: str("/data") } }],
      },
    });
    expect(out.resource.comments?.join(" ")).toContain("vol2");
  });

  it("keeps registry passwords in a sensitive variable, and says it cannot import", () => {
    const out = runpodTerraformExport.mapResource(
      instance("container-registry-auth", "clz1", { name: "ghcr" }),
    )!;
    expect(out.resource.type).toBe("runpod_registry");
    expect(out.resource.importId).toBeUndefined();
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
