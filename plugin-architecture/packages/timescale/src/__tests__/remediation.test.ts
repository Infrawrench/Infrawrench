import { describe, expect, it } from "vitest";
import type { RemediationFinding, RemediationResource } from "@infrawrench/plugin-base";
import { timescaleRemediationCommands } from "../remediation.js";
import { plugin } from "../plugin.js";

function res(resourceTypeId: string, externalId: string | null): RemediationResource {
  return { resourceTypeId, displayName: "x", externalId, fields: {} };
}

/** One line per command; "!" marks destructive ones. */
function lines(finding: RemediationFinding): string[] {
  return timescaleRemediationCommands(finding).map(
    (c) => `${c.destructive ? "!" : "-"} ${c.command}`,
  );
}

describe("timescaleRemediationCommands", () => {
  it("is wired on the plugin", () => {
    expect(plugin.remediationCommands).toBe(timescaleRemediationCommands);
  });

  it("stops and starts a service with the tiger CLI", () => {
    expect(
      lines({ kind: "sleep-schedule", resource: res("ts-service", "prj1/svc-12345") }),
    ).toEqual(["- tiger service stop svc-12345", "- tiger service start svc-12345"]);
  });

  it("deletes an exporter no service uses", () => {
    const commands = timescaleRemediationCommands({
      kind: "orphan",
      reason: "r",
      resource: res("ts-exporter", "prj1/exp 1"),
    });
    expect(commands.map((c) => c.command)).toEqual([
      `curl -sS -X DELETE https://console.cloud.tigerdata.com/public/api/v1/projects/prj1/exporters/exp%201 -u "$TIGER_PUBLIC_KEY:$TIGER_SECRET_KEY"`,
    ]);
    expect(commands[0]?.destructive).toBe(true);
    expect(commands[0]?.placeholders?.map((p) => p.name)).toEqual([
      "TIGER_PUBLIC_KEY",
      "TIGER_SECRET_KEY",
    ]);
  });

  it("quotes a hostile service id", () => {
    expect(lines({ kind: "sleep-schedule", resource: res("ts-service", "p/s; rm") })[0]).toBe(
      "- tiger service stop 's; rm'",
    );
  });

  it("returns nothing for missing ids, other types and other kinds", () => {
    expect(lines({ kind: "sleep-schedule", resource: res("ts-service", null) })).toEqual([]);
    expect(lines({ kind: "sleep-schedule", resource: res("ts-service", "svc-1") })).toEqual([]);
    expect(lines({ kind: "orphan", reason: "r", resource: res("ts-exporter", "p/") })).toEqual([]);
    expect(lines({ kind: "orphan", reason: "r", resource: res("ts-service", "p/s") })).toEqual([]);
    expect(lines({ kind: "sleep-schedule", resource: res("ts-exporter", "p/e") })).toEqual([]);
  });
});
