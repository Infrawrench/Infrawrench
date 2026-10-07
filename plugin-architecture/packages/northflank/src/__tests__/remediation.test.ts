import { describe, expect, it } from "vitest";
import type { RemediationFinding, RemediationResource } from "@infrawrench/plugin-base";
import { northflankRemediationCommands } from "../remediation.js";
import { plugin } from "../plugin.js";

function res(
  resourceTypeId: string,
  externalId: string | null,
  fields: RemediationResource["fields"] = {},
): RemediationResource {
  return { resourceTypeId, displayName: "x", externalId, fields };
}

/** One line per command; "!" marks destructive ones. */
function lines(finding: RemediationFinding): string[] {
  return northflankRemediationCommands(finding).map(
    (c) => `${c.destructive ? "!" : "-"} ${c.command}`,
  );
}

describe("northflankRemediationCommands", () => {
  it("is wired on the plugin", () => {
    expect(plugin.remediationCommands).toBe(northflankRemediationCommands);
  });

  it("pauses and resumes a service with its stored instance count", () => {
    expect(
      lines({
        kind: "sleep-schedule",
        resource: res("nf-service", "my-project/api", { instances: 2, state: "running" }),
      }),
    ).toEqual([
      "- northflank pause service --projectId my-project --serviceId api",
      `- northflank resume service --projectId my-project --serviceId api --input '{"instances":2}'`,
    ]);
  });

  it("resumes a paused service without an instance count", () => {
    expect(
      lines({ kind: "sleep-schedule", resource: res("nf-service", "p/api", { instances: 0 }) })[1],
    ).toBe("- northflank resume service --projectId p --serviceId api");
  });

  it("pauses and resumes an addon", () => {
    expect(
      lines({ kind: "sleep-schedule", resource: res("nf-addon", "my-project/pg; rm") }),
    ).toEqual([
      "- northflank pause addon --projectId my-project --addonId 'pg; rm'",
      "- northflank resume addon --projectId my-project --addonId 'pg; rm'",
    ]);
  });

  it("returns nothing for missing ids, other types and other kinds", () => {
    expect(lines({ kind: "sleep-schedule", resource: res("nf-service", null) })).toEqual([]);
    expect(lines({ kind: "sleep-schedule", resource: res("nf-service", "noslash") })).toEqual([]);
    expect(lines({ kind: "sleep-schedule", resource: res("nf-service", "p/") })).toEqual([]);
    expect(lines({ kind: "sleep-schedule", resource: res("nf-job", "p/j") })).toEqual([]);
    expect(lines({ kind: "orphan", reason: "r", resource: res("nf-service", "p/s") })).toEqual([]);
  });
});
