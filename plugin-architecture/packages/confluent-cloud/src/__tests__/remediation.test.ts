import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { RemediationFinding, RemediationResource } from "@infrawrench/plugin-base";
import { confluentRemediationCommands } from "../remediation.js";
import { plugin } from "../plugin.js";

beforeAll(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-04T12:00:00Z"));
});
afterAll(() => {
  vi.useRealTimers();
});

function res(
  resourceTypeId: string,
  externalId: string | null,
  fields: RemediationResource["fields"] = {},
  displayName = "orders",
): RemediationResource {
  return { resourceTypeId, displayName, externalId, fields };
}

/** One line per command; "!" marks destructive ones. */
function lines(finding: RemediationFinding): string[] {
  return confluentRemediationCommands(finding).map(
    (c) => `${c.destructive ? "!" : "-"} ${c.command}`,
  );
}

const orphan = (resource: RemediationResource): RemediationFinding => ({
  kind: "orphan",
  reason: "idle",
  resource,
});

describe("confluentRemediationCommands", () => {
  it("is wired on the plugin", () => {
    expect(plugin.remediationCommands).toBe(confluentRemediationCommands);
  });

  it("shrinks a Dedicated cluster one CKU at a time", () => {
    expect(
      lines({
        kind: "oversized",
        resource: res("kafka-cluster", "lkc-9x8y7z", {
          clusterId: "lkc-9x8y7z",
          environmentId: "env-a1b2c3",
          cku: 4,
        }),
        sizeFieldKey: "cku",
        currentSize: "4",
        targetSize: "2",
        region: "AWS/us-east-1/MULTI_ZONE",
      }),
    ).toMatchInlineSnapshot(`
      [
        "- confluent kafka cluster update lkc-9x8y7z --cku 3 --environment env-a1b2c3",
        "- confluent kafka cluster update lkc-9x8y7z --cku 2 --environment env-a1b2c3",
      ]
    `);
  });

  it("grows a cluster in one step", () => {
    expect(
      lines({
        kind: "oversized",
        resource: res("kafka-cluster", "lkc-9x8y7z", { environmentId: "env-a1b2c3" }),
        sizeFieldKey: "cku",
        currentSize: "1",
        targetSize: "2",
        region: null,
      }),
    ).toMatchInlineSnapshot(`
      [
        "- confluent kafka cluster update lkc-9x8y7z --cku 2 --environment env-a1b2c3",
      ]
    `);
  });

  it("describes, lists topics and deletes an idle cluster", () => {
    expect(
      lines(
        orphan(
          res("kafka-cluster", "lkc-9x8y7z", {
            clusterId: "lkc-9x8y7z",
            environmentId: "env-a1b2c3",
            idle: "true",
          }),
        ),
      ),
    ).toMatchInlineSnapshot(`
      [
        "- confluent kafka cluster describe lkc-9x8y7z --environment env-a1b2c3 --output json",
        "- confluent kafka topic list --cluster lkc-9x8y7z --environment env-a1b2c3",
        "! confluent kafka cluster delete lkc-9x8y7z --environment env-a1b2c3 --force",
      ]
    `);
  });

  it("saves and deletes an idle connector, quoting every value", () => {
    expect(
      lines(
        orphan(
          res(
            "connector",
            "lcc-k3m9q2",
            {
              connectorId: "lcc-k3m9q2",
              clusterId: "lkc-9x8y7z",
              environmentId: "env-a1b2c3; rm -rf ~",
              idle: "true",
            },
            "s3 sink",
          ),
        ),
      ),
    ).toMatchInlineSnapshot(`
      [
        "- confluent connect cluster describe lcc-k3m9q2 --cluster lkc-9x8y7z --environment 'env-a1b2c3; rm -rf ~' --output json > lcc-k3m9q2-connector.json",
        "! confluent connect cluster delete lcc-k3m9q2 --cluster lkc-9x8y7z --environment 'env-a1b2c3; rm -rf ~' --force",
      ]
    `);
  });

  it("needs a connector id, not just a name", () => {
    expect(
      lines(orphan(res("connector", "s3-sink", { clusterId: "lkc-9x8y7z", idle: "true" }))),
    ).toEqual([]);
  });

  it("deletes an idle network", () => {
    expect(
      lines(
        orphan(
          res("network", "n-4f7g2h", {
            networkId: "n-4f7g2h",
            environmentId: "env-a1b2c3",
            idleSince: "2026-09-01T00:00:00Z",
          }),
        ),
      ),
    ).toMatchInlineSnapshot(`
      [
        "- confluent network describe n-4f7g2h --environment env-a1b2c3 --output json",
        "! confluent network delete n-4f7g2h --environment env-a1b2c3 --force",
      ]
    `);
  });

  it("returns nothing for unknown types and unsupported kinds", () => {
    expect(lines(orphan(res("flink-compute-pool", "lfcp-123")))).toEqual([]);
    expect(lines({ kind: "sleep-schedule", resource: res("kafka-cluster", "lkc-1") })).toEqual([]);
    expect(lines(orphan(res("kafka-cluster", null)))).toEqual([]);
  });
});
