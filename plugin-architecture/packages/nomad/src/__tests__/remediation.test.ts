import { describe, expect, it } from "vitest";
import type { RemediationFinding, RemediationResource } from "@infrawrench/plugin-base";
import { nomadRemediationCommands } from "../remediation.js";
import { plugin } from "../plugin.js";

function res(resourceTypeId: string, externalId: string | null): RemediationResource {
  return { resourceTypeId, displayName: "client-1", externalId, fields: { status: "down" } };
}

const orphan = (resource: RemediationResource): RemediationFinding => ({
  kind: "orphan",
  reason: "down",
  resource,
});

/** One line per command; "!" marks destructive ones. */
function lines(finding: RemediationFinding): string[] {
  return nomadRemediationCommands(finding).map((c) => `${c.destructive ? "!" : "-"} ${c.command}`);
}

describe("nomadRemediationCommands", () => {
  it("is wired on the plugin", () => {
    expect(plugin.remediationCommands).toBe(nomadRemediationCommands);
  });

  it("checks, then purges a down node through the operator API", () => {
    expect(lines(orphan(res("nomad-node", "f7476465-4d6e-c0de-26d0-e383c49be941"))))
      .toMatchInlineSnapshot(`
      [
        "- nomad node status f7476465-4d6e-c0de-26d0-e383c49be941",
        "! nomad operator api -X POST /v1/node/f7476465-4d6e-c0de-26d0-e383c49be941/purge",
      ]
    `);
  });

  it("quotes and encodes a hostile id", () => {
    expect(lines(orphan(res("nomad-node", "x; rm -rf ~")))).toEqual([
      "- nomad node status 'x; rm -rf ~'",
      "! nomad operator api -X POST '/v1/node/x%3B%20rm%20-rf%20~/purge'",
    ]);
  });

  it("returns nothing without an id, or for other kinds and types", () => {
    expect(nomadRemediationCommands(orphan(res("nomad-node", null)))).toEqual([]);
    expect(nomadRemediationCommands(orphan(res("nomad-job", "web")))).toEqual([]);
    expect(
      nomadRemediationCommands({ kind: "sleep-schedule", resource: res("nomad-node", "n1") }),
    ).toEqual([]);
  });
});
