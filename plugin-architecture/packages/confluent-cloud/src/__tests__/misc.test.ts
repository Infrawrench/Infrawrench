import { describe, expect, it } from "vitest";
import type { ResourceInstance } from "@infrawrench/plugin-base";
import { evaluateOrphanRule } from "@infrawrench/plugin-base";
import { granularityFor, rangeOrDefault } from "../metrics.js";
import { ckuOptions } from "../render.js";
import {
  ConnectorResourceType,
  KafkaClusterResourceType,
  NetworkResourceType,
} from "../resource-types.js";
import { parseStatusFeed, regionsInTitle } from "../status-feed.js";
import { confluentTerraformExport } from "../terraform.js";

describe("status feed", () => {
  it("lifts cloud regions out of incident titles", () => {
    expect(regionsInTitle("Connectivity degradation - AWS us-east-1")).toEqual(["us-east-1"]);
    expect(regionsInTitle("Flink statements degraded in GCP us-central1 region")).toEqual([
      "us-central1",
    ]);
    expect(regionsInTitle("Elevated error rates in Azure Germany West Central region")).toEqual([
      "germanywestcentral",
    ]);
    expect(regionsInTitle("Elevated error rates in Azure East US")).toEqual(["eastus"]);
    expect(regionsInTitle("Missing Metrics on Confluent Cloud")).toEqual([]);
  });

  it("scopes regional incidents and keeps all-region ones provider-wide", () => {
    const body = JSON.stringify({
      incidents: [
        {
          id: "a",
          name: "Elevated error rates in Azure East US",
          status: "investigating",
          impact: "minor",
          created_at: "2026-09-26T00:00:00Z",
          components: [{ name: "Confluent Cloud" }],
          incident_updates: [],
        },
        {
          id: "b",
          name: "Confluent Cloud Console Degraded (All Regions) and Multiple Services Impacted in AWS us-west-2",
          status: "investigating",
          impact: "major",
          created_at: "2026-09-23T00:00:00Z",
          components: [{ name: "Confluent Cloud" }],
          incident_updates: [],
        },
      ],
    });
    const [a, b] = parseStatusFeed(body);
    expect(a).toMatchObject({ regions: ["eastus"], providerWide: false });
    expect(b!.providerWide).toBe(true);
  });
});

describe("metrics windows", () => {
  it("clamps to the seven-day retention and picks an allowed granularity", () => {
    const now = Date.parse("2026-10-04T12:00:00Z");
    const r = rangeOrDefault({ startMs: now - 30 * 86_400_000, endMs: now }, now);
    expect(now - r.startMs).toBeLessThanOrEqual(7 * 86_400_000);
    expect(granularityFor({ startMs: 0, endMs: 3 * 3_600_000 })).toBe("PT1M");
    expect(granularityFor({ startMs: 0, endMs: 24 * 3_600_000 })).toBe("PT5M");
    expect(granularityFor({ startMs: 0, endMs: 3 * 86_400_000 })).toBe("PT15M");
    expect(granularityFor({ startMs: 0, endMs: 7 * 86_400_000 })).toBe("PT30M");
    expect(granularityFor({ startMs: 0, endMs: 10 * 86_400_000 })).toBe("PT1H");
  });
});

describe("resize choices", () => {
  it("never offers 1 CKU to a multi-zone cluster", () => {
    expect(ckuOptions("MULTI_ZONE", 4)[0]).toBe(2);
    expect(ckuOptions("SINGLE_ZONE", 4)[0]).toBe(1);
    expect(ckuOptions("SINGLE_ZONE", 30).at(-1)).toBe(34);
  });
});

describe("orphan rules", () => {
  it("flag only resources the Metrics API measured as idle", () => {
    const rule = KafkaClusterResourceType.orphanRule;
    expect(evaluateOrphanRule(rule, { idle: "true" })).not.toBeNull();
    expect(evaluateOrphanRule(rule, { idle: "false" })).toBeNull();
    expect(evaluateOrphanRule(rule, {})).toBeNull();
    expect(evaluateOrphanRule(ConnectorResourceType.orphanRule, { idle: "true" })).not.toBeNull();
    expect(evaluateOrphanRule(NetworkResourceType.orphanRule, {})).toBeNull();
    expect(
      evaluateOrphanRule(NetworkResourceType.orphanRule, { idleSince: "2026-09-01T00:00:00Z" }),
    ).not.toBeNull();
  });
});

function res(
  typeId: string,
  fields: ResourceInstance["fields"],
  externalId: string,
): ResourceInstance {
  return {
    id: `acc:${typeId}:${externalId}`,
    pluginId: "confluent-cloud",
    resourceTypeId: typeId,
    accountId: "acc",
    displayName: String(fields["name"] ?? externalId),
    fields,
    resolvedOutputs: {},
    secretStates: [],
    externalId,
    createdAt: "",
    updatedAt: "",
  };
}

describe("terraform export", () => {
  it("maps a Dedicated cluster with its CKUs and an env/cluster import id", () => {
    const out = confluentTerraformExport.mapResource(
      res(
        "kafka-cluster",
        {
          name: "orders",
          clusterType: "Dedicated",
          cku: 4,
          cloud: "AWS",
          region: "us-east-1",
          availability: "MULTI_ZONE",
          environmentId: "env-1",
          clusterId: "lkc-1",
        },
        "lkc-1",
      ),
    );
    expect(out?.resource.type).toBe("confluent_kafka_cluster");
    expect(out?.resource.importId).toBe("env-1/lkc-1");
    expect(out?.resource.attributes["dedicated"]).toEqual({
      kind: "block",
      attributes: { cku: { kind: "number", value: 4 } },
    });
  });

  it("maps an elastic cluster to its own type block and skips unknown types", () => {
    const base = {
      name: "s",
      cloud: "GCP",
      region: "us-central1",
      availability: "SINGLE_ZONE",
      environmentId: "env-1",
    };
    const std = confluentTerraformExport.mapResource(
      res("kafka-cluster", { ...base, clusterType: "Standard", maxEcku: 2 }, "lkc-2"),
    );
    expect(Object.keys(std!.resource.attributes)).toContain("standard");
    expect(
      confluentTerraformExport.mapResource(
        res("kafka-cluster", { ...base, clusterType: "?" }, "x"),
      ),
    ).toBeNull();
  });

  it("maps environments, compute pools and service accounts", () => {
    expect(
      confluentTerraformExport.mapResource(
        res(
          "environment",
          { name: "prod", streamGovernance: "ADVANCED", environmentId: "env-1" },
          "env-1",
        ),
      )?.resource.importId,
    ).toBe("env-1");
    expect(
      confluentTerraformExport.mapResource(
        res(
          "flink-compute-pool",
          {
            name: "p",
            maxCfu: "10",
            cloud: "AWS",
            region: "us-east-1",
            environmentId: "env-1",
            poolId: "lfcp-1",
          },
          "lfcp-1",
        ),
      )?.resource.importId,
    ).toBe("env-1/lfcp-1");
    expect(
      confluentTerraformExport.mapResource(
        res("service-account", { name: "app", serviceAccountId: "sa-1" }, "sa-1"),
      )?.resource.type,
    ).toBe("confluent_service_account");
  });
});
