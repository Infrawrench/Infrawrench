import { describe, expect, it } from "vitest";
import type { RemediationFinding, RemediationResource } from "@infrawrench/plugin-base";
import { herokuRemediationCommands } from "../remediation.js";
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
  return herokuRemediationCommands(finding).map((c) => `${c.destructive ? "!" : "-"} ${c.command}`);
}

describe("herokuRemediationCommands", () => {
  it("is wired on the plugin", () => {
    expect(plugin.remediationCommands).toBe(herokuRemediationCommands);
  });

  it("scales a process type to zero and back to its stored quantity", () => {
    expect(
      lines({
        kind: "sleep-schedule",
        resource: res("formation", "app-uuid/worker", {
          type: "worker",
          quantity: 3,
          appName: "acme-api",
          appId: "app-uuid",
        }),
      }),
    ).toEqual([
      "- heroku ps:scale worker=0 --app acme-api",
      "- heroku ps:scale worker=3 --app acme-api",
    ]);
  });

  it("falls back to the scoped external id and one dyno when stopped", () => {
    expect(
      lines({
        kind: "sleep-schedule",
        resource: res("formation", "app-uuid/web", { quantity: 0 }),
      }),
    ).toEqual(["- heroku ps:scale web=0 --app app-uuid", "- heroku ps:scale web=1 --app app-uuid"]);
  });

  it("destroys an orphaned add-on, backing up Postgres first", () => {
    expect(
      lines({
        kind: "orphan",
        reason: "r",
        resource: res("add-on", "addon-uuid", {
          name: "postgresql-sinuous-83720",
          service: "heroku-postgresql",
          appName: "acme-api",
        }),
      }),
    ).toEqual([
      "- heroku pg:backups:capture postgresql-sinuous-83720 --app acme-api",
      "! heroku addons:destroy postgresql-sinuous-83720 --app acme-api --confirm acme-api",
    ]);
    expect(
      lines({
        kind: "orphan",
        reason: "r",
        resource: res("add-on", "addon-uuid", { name: "papertrail-x; rm -rf ~" }),
      }),
    ).toEqual([`! heroku addons:destroy 'papertrail-x; rm -rf ~'`]);
  });

  it("returns nothing for missing ids, other types and other kinds", () => {
    expect(lines({ kind: "sleep-schedule", resource: res("formation", null) })).toEqual([]);
    expect(lines({ kind: "orphan", reason: "r", resource: res("add-on", null) })).toEqual([]);
    expect(lines({ kind: "orphan", reason: "r", resource: res("app", "a") })).toEqual([]);
    expect(
      lines({
        kind: "oversized",
        resource: res("formation", "a/web", { type: "web", appName: "a" }),
        sizeFieldKey: "size",
        currentSize: "Performance-L",
        targetSize: "Standard-2X",
        region: null,
      }),
    ).toEqual([]);
  });
});
