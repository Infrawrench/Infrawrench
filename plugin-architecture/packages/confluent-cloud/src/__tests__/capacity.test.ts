import { capacityDeclarations, resolveCapacityLimit } from "@infrawrench/plugin-base";
import { describe, expect, it } from "vitest";
import { mapKafkaCluster, partitionLimit } from "../mappers.js";
import { CLUSTER_SERIES } from "../metrics.js";
import { KafkaClusterResourceType } from "../resource-types.js";
import type { CcKafkaCluster } from "../types.js";

const cluster = (config: NonNullable<CcKafkaCluster["spec"]>["config"], cku?: number) =>
  ({
    id: "lkc-abc12",
    spec: {
      display_name: "orders",
      availability: "MULTI_ZONE",
      cloud: "AWS",
      region: "us-east-2",
      config,
      environment: { id: "env-x1" },
      kafka_bootstrap_endpoint: "SASL_SSL://pkc-1.us-east-2.aws.confluent.cloud:9092",
    },
    status: { phase: "PROVISIONED", ...(cku !== undefined ? { cku } : {}) },
  }) as CcKafkaCluster;

describe("kafka cluster partitions", () => {
  it("works out an elastic cluster's limit from its max eCKU", () => {
    const r = mapKafkaCluster("acct", cluster({ kind: "Standard", max_ecku: 4 }), "prod", {
      partitions: 612,
    });
    expect(r.fields["partitions"]).toBe(612);
    expect(r.fields["partitionLimit"]).toBe(1_000);
    const decl = capacityDeclarations(KafkaClusterResourceType).find(
      (d) => d.valueKey === "partitions",
    )!;
    expect(resolveCapacityLimit(decl.declaration.limit, r.fields)?.limit).toBe(1_000);
  });

  it("works out a Dedicated cluster's limit from its CKUs, capped per cluster", () => {
    const r = mapKafkaCluster("acct", cluster({ kind: "Dedicated", cku: 2 }, 2));
    expect(r.fields["partitionLimit"]).toBe(9_000);
    expect(partitionLimit("Dedicated", 30)).toBe(100_000);
    expect(partitionLimit("Basic", 50)).toBe(1_500);
  });

  it("leaves the limit out when the size is unknown", () => {
    const r = mapKafkaCluster("acct", cluster({ kind: "Basic" }));
    expect(r.fields["partitionLimit"]).toBeUndefined();
    expect(partitionLimit("Unknown", 4)).toBeUndefined();
  });

  it("declares cluster load against the series label the metrics code emits", () => {
    const labels = CLUSTER_SERIES.map((s) => s.label);
    for (const d of capacityDeclarations(KafkaClusterResourceType)) {
      if (d.source === "metric") expect(labels).toContain(d.valueKey);
    }
    const load = capacityDeclarations(KafkaClusterResourceType).find(
      (d) => d.valueKey === "CKU utilization",
    )!;
    expect(resolveCapacityLimit(load.declaration.limit, {})?.limit).toBe(100);
  });
});

describe("schema registry schemas", () => {
  it("reads the Advanced package's schema cap and none for Essentials", async () => {
    const { SchemaRegistryResourceType } = await import("../resource-types.js");
    const { SCHEMA_REGISTRY_SERIES } = await import("../metrics.js");
    const [decl] = capacityDeclarations(SchemaRegistryResourceType);
    expect(SCHEMA_REGISTRY_SERIES.map((s) => s.label)).toContain(decl?.valueKey);
    expect(resolveCapacityLimit(decl!.declaration.limit, { package: "ADVANCED" })?.limit).toBe(
      20_000,
    );
    expect(resolveCapacityLimit(decl!.declaration.limit, { package: "ESSENTIALS" })).toBeNull();
  });
});
