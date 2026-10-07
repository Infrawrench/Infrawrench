import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { RemediationFinding, RemediationResource } from "@infrawrench/plugin-base";
import { jfrogRemediationCommands } from "../remediation.js";
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
): RemediationResource {
  return { resourceTypeId, displayName: "x", externalId, fields };
}

const orphan = (resource: RemediationResource): RemediationFinding => ({
  kind: "orphan",
  reason: "unused",
  resource,
});

/** One line per command; "!" marks destructive ones. */
const lines = (finding: RemediationFinding) =>
  jfrogRemediationCommands(finding).map((c) => `${c.destructive ? "!" : "-"} ${c.command}`);

describe("jfrogRemediationCommands", () => {
  it("is wired on the plugin", () => {
    expect(plugin.remediationCommands).toBe(jfrogRemediationCommands);
  });

  it("saves, then deletes an empty repository and an unused policy", () => {
    expect([
      ...lines(orphan(res("jfrog-repository", "libs-local", { key: "libs-local" }))),
      ...lines(orphan(res("jfrog-xray-policy", "sec policy"))),
    ]).toMatchInlineSnapshot(`
      [
        "- jf api /artifactory/api/repositories/libs-local > libs-local-repository-20261004.json",
        "! jf api /artifactory/api/repositories/libs-local -X DELETE",
        "- jf api /xray/api/v1/policies/sec%20policy > sec_policy-xray-policy-20261004.json",
        "! jf api /xray/api/v1/policies/sec%20policy -X DELETE",
      ]
    `);
  });

  it("returns nothing it cannot address", () => {
    expect(lines(orphan(res("jfrog-repository", null)))).toEqual([]);
    expect(lines(orphan(res("jfrog-xray-watch", "w")))).toEqual([]);
    expect(lines({ kind: "sleep-schedule", resource: res("jfrog-repository", "r") })).toEqual([]);
  });
});
