import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { RemediationFinding, RemediationResource } from "@infrawrench/plugin-base";
import { togetherRemediationCommands } from "../remediation.js";
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
  displayName = "llama-prod",
): RemediationResource {
  return { resourceTypeId, displayName, externalId, fields };
}

/** One line per command; "!" marks destructive ones. */
function lines(finding: RemediationFinding): string[] {
  return togetherRemediationCommands(finding).map(
    (c) => `${c.destructive ? "!" : "-"} ${c.command}`,
  );
}

describe("togetherRemediationCommands", () => {
  it("is wired on the plugin", () => {
    expect(plugin.remediationCommands).toBe(togetherRemediationCommands);
  });

  it("stops and starts a dedicated endpoint", () => {
    const commands = togetherRemediationCommands({
      kind: "sleep-schedule",
      resource: res("endpoint", "endpoint-c2a48674-9ec7-45b3-ac30-0f25f2ad9462", {
        endpointId: "endpoint-c2a48674-9ec7-45b3-ac30-0f25f2ad9462",
        state: "STARTED",
      }),
    });
    expect(commands.map((c) => c.command)).toMatchInlineSnapshot(`
      [
        "together endpoints stop endpoint-c2a48674-9ec7-45b3-ac30-0f25f2ad9462 --wait",
        "together endpoints start endpoint-c2a48674-9ec7-45b3-ac30-0f25f2ad9462 --wait",
      ]
    `);
    expect(commands[0]?.placeholders?.map((p) => p.name)).toEqual(["TOGETHER_API_KEY"]);
  });

  it("quotes an id with shell metacharacters", () => {
    expect(lines({ kind: "sleep-schedule", resource: res("endpoint", "endpoint-1; rm -rf ~") }))
      .toMatchInlineSnapshot(`
      [
        "- together endpoints stop 'endpoint-1; rm -rf ~' --wait",
        "- together endpoints start 'endpoint-1; rm -rf ~' --wait",
      ]
    `);
  });

  it("returns nothing for unknown types, missing ids and other kinds", () => {
    expect(lines({ kind: "sleep-schedule", resource: res("fine-tune", "ft-1") })).toEqual([]);
    expect(lines({ kind: "sleep-schedule", resource: res("endpoint", null) })).toEqual([]);
    expect(lines({ kind: "orphan", reason: "x", resource: res("endpoint", "endpoint-1") })).toEqual(
      [],
    );
  });
});
