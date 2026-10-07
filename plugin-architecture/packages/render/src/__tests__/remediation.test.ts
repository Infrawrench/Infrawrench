import { describe, expect, it } from "vitest";
import type { RemediationFinding, RemediationResource } from "@infrawrench/plugin-base";
import { renderRemediationCommands } from "../remediation.js";
import { plugin } from "../plugin.js";

function res(
  resourceTypeId: string,
  externalId: string | null,
  fields: RemediationResource["fields"] = {},
): RemediationResource {
  return { resourceTypeId, displayName: "my-app", externalId, fields };
}

/** One line per command; "!" marks destructive ones. */
function lines(finding: RemediationFinding): string[] {
  return renderRemediationCommands(finding).map((c) => `${c.destructive ? "!" : "-"} ${c.command}`);
}

describe("renderRemediationCommands", () => {
  it("is wired on the plugin", () => {
    expect(plugin.remediationCommands).toBe(renderRemediationCommands);
  });

  it("deletes a service a user suspended", () => {
    expect(
      lines({
        kind: "orphan",
        reason: "Suspended by a user",
        resource: res("service", "srv-cukouhrtq21c73e9scng", { suspenders: "user" }),
      }),
    ).toMatchInlineSnapshot(`
      [
        "! render services delete srv-cukouhrtq21c73e9scng --confirm",
      ]
    `);
  });

  it("suspends and resumes a service through the API", () => {
    const commands = renderRemediationCommands({
      kind: "sleep-schedule",
      resource: res("service", "srv-cukouhrtq21c73e9scng"),
    });
    expect(commands.map((c) => c.command)).toMatchInlineSnapshot(`
      [
        "curl -sS -X POST https://api.render.com/v1/services/srv-cukouhrtq21c73e9scng/suspend -H "Authorization: Bearer $RENDER_API_KEY"",
        "curl -sS -X POST https://api.render.com/v1/services/srv-cukouhrtq21c73e9scng/resume -H "Authorization: Bearer $RENDER_API_KEY"",
      ]
    `);
    expect(commands[0]?.placeholders?.map((p) => p.name)).toEqual(["RENDER_API_KEY"]);
  });

  it("suspends and resumes Postgres and Key Value with the CLI", () => {
    expect(lines({ kind: "sleep-schedule", resource: res("postgres", "dpg-abc123") }))
      .toMatchInlineSnapshot(`
      [
        "- render pg suspend dpg-abc123 --confirm",
        "- render pg resume dpg-abc123",
      ]
    `);
    expect(lines({ kind: "sleep-schedule", resource: res("key-value", "red-abc123") }))
      .toMatchInlineSnapshot(`
      [
        "- render kv suspend red-abc123 --confirm",
        "- render kv resume red-abc123",
      ]
    `);
  });

  it("quotes an id with shell metacharacters", () => {
    expect(lines({ kind: "sleep-schedule", resource: res("postgres", "dpg-1; rm -rf ~") }))
      .toMatchInlineSnapshot(`
      [
        "- render pg suspend 'dpg-1; rm -rf ~' --confirm",
        "- render pg resume 'dpg-1; rm -rf ~'",
      ]
    `);
  });

  it("returns nothing for missing ids, other types and other kinds", () => {
    expect(lines({ kind: "orphan", reason: "x", resource: res("service", null) })).toEqual([]);
    expect(lines({ kind: "sleep-schedule", resource: res("postgres", "") })).toEqual([]);
    expect(lines({ kind: "sleep-schedule", resource: res("deploy", "srv-1/dep-1") })).toEqual([]);
    expect(lines({ kind: "orphan", reason: "x", resource: res("postgres", "dpg-1") })).toEqual([]);
    expect(
      lines({
        kind: "oversized",
        resource: res("service", "srv-1"),
        sizeFieldKey: "plan",
        currentSize: "pro",
        targetSize: "standard",
        region: "oregon",
      }),
    ).toEqual([]);
  });
});
