import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { RemediationFinding, RemediationResource } from "@infrawrench/plugin-base";
import { buildkiteRemediationCommands } from "../remediation.js";
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
  return { resourceTypeId, displayName: "deploy", externalId, fields };
}

/** One line per command; "!" marks destructive ones. */
const lines = (finding: RemediationFinding) =>
  buildkiteRemediationCommands(finding).map((c) => `${c.destructive ? "!" : "-"} ${c.command}`);

describe("buildkiteRemediationCommands", () => {
  it("is wired on the plugin", () => {
    expect(plugin.remediationCommands).toBe(buildkiteRemediationCommands);
  });

  it("saves, then deletes an archived pipeline", () => {
    expect(
      lines({
        kind: "orphan",
        reason: "archived",
        resource: res("pipeline", "deploy-web", { slug: "deploy-web" }),
      }),
    ).toMatchInlineSnapshot(`
      [
        "- bk pipeline view deploy-web -o json > deploy-web-pipeline-20261004.json",
        "! bk api --method DELETE /pipelines/deploy-web",
      ]
    `);
  });

  it("pauses and resumes queue dispatch", () => {
    expect(
      lines({
        kind: "sleep-schedule",
        resource: res("queue", "c-uuid/q-uuid", { clusterId: "c-uuid", queueId: "q-uuid" }),
      }),
    ).toMatchInlineSnapshot(`
      [
        "- bk queue pause c-uuid q-uuid --note 'Sleep schedule'",
        "- bk queue resume c-uuid q-uuid",
      ]
    `);
    expect(lines({ kind: "sleep-schedule", resource: res("queue", "c-uuid/q-uuid") })).toHaveLength(
      2,
    );
  });

  it("returns nothing it cannot address", () => {
    expect(lines({ kind: "orphan", reason: "x", resource: res("pipeline", null) })).toEqual([]);
    expect(lines({ kind: "sleep-schedule", resource: res("queue", "c-uuid") })).toEqual([]);
    expect(lines({ kind: "sleep-schedule", resource: res("pipeline", "p") })).toEqual([]);
    expect(lines({ kind: "orphan", reason: "x", resource: res("agent", "a") })).toEqual([]);
  });
});
