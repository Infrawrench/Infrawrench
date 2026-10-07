import { describe, expect, it } from "vitest";
import type { RemediationFinding, RemediationResource } from "@infrawrench/plugin-base";
import { aivenRemediationCommands } from "../remediation.js";
import { plugin } from "../plugin.js";
import { T } from "../resource-types.js";

function res(
  resourceTypeId: string,
  externalId: string | null,
  fields: RemediationResource["fields"] = {},
): RemediationResource {
  return { resourceTypeId, displayName: "pg-1", externalId, fields };
}

function lines(finding: RemediationFinding): string[] {
  return aivenRemediationCommands(finding).map((c) => `${c.destructive ? "!" : "-"} ${c.command}`);
}

const sleep = (resource: RemediationResource): RemediationFinding => ({
  kind: "sleep-schedule",
  resource,
});

describe("aivenRemediationCommands", () => {
  it("is wired on the plugin", () => {
    expect(plugin.remediationCommands).toBe(aivenRemediationCommands);
  });

  it("powers a service off and on", () => {
    expect(lines(sleep(res(T.service, "my-proj/pg-1")))).toEqual([
      "- avn service update --project my-proj pg-1 --power-off",
      "- avn service update --project my-proj pg-1 --power-on",
    ]);
  });

  it("pauses and resumes a Kafka connector", () => {
    expect(lines(sleep(res(T.connector, "my-proj/kafka-1/s3 sink")))).toEqual([
      "- avn service connector pause --project my-proj kafka-1 's3 sink'",
      "- avn service connector resume --project my-proj kafka-1 's3 sink'",
    ]);
  });

  it("falls back to stored fields", () => {
    expect(lines(sleep(res(T.service, null, { project: "p", name: "s" }))).length).toBe(2);
  });

  it("returns nothing without ids or for other findings", () => {
    expect(lines(sleep(res(T.service, null)))).toEqual([]);
    expect(lines(sleep(res(T.connector, "p/s")))).toEqual([]);
    expect(lines({ kind: "orphan", reason: "x", resource: res(T.service, "p/s") })).toEqual([]);
    expect(lines(sleep(res(T.project, "p")))).toEqual([]);
  });
});
