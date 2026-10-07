import { describe, expect, it } from "vitest";
import type { RemediationFinding, RemediationResource } from "@infrawrench/plugin-base";
import { upstashRemediationCommands } from "../remediation.js";
import { plugin } from "../plugin.js";

function res(resourceTypeId: string, externalId: string | null): RemediationResource {
  return { resourceTypeId, displayName: "x", externalId, fields: {} };
}

/** One line per command; "!" marks destructive ones. */
function lines(finding: RemediationFinding): string[] {
  return upstashRemediationCommands(finding).map(
    (c) => `${c.destructive ? "!" : "-"} ${c.command}`,
  );
}

const AUTH = `-H "Authorization: Bearer $QSTASH_TOKEN"`;

describe("upstashRemediationCommands", () => {
  it("is wired on the plugin", () => {
    expect(plugin.remediationCommands).toBe(upstashRemediationCommands);
  });

  it("pauses and resumes a QStash schedule", () => {
    const commands = upstashRemediationCommands({
      kind: "sleep-schedule",
      resource: res("upstash-qstash-schedule", "qs-1/scd_2Xy9"),
    });
    expect(commands.map((c) => c.command)).toEqual([
      `curl -sS -X POST "$QSTASH_URL"/v2/schedules/scd_2Xy9/pause ${AUTH}`,
      `curl -sS -X POST "$QSTASH_URL"/v2/schedules/scd_2Xy9/resume ${AUTH}`,
    ]);
    expect(commands[0]?.placeholders?.map((p) => p.name)).toEqual(["QSTASH_URL", "QSTASH_TOKEN"]);
  });

  it("pauses and resumes a queue, encoding its name", () => {
    expect(
      lines({ kind: "sleep-schedule", resource: res("upstash-qstash-queue", "qs-1/emails; id") }),
    ).toEqual([
      `- curl -sS -X POST "$QSTASH_URL"/v2/queues/emails%3B%20id/pause ${AUTH}`,
      `- curl -sS -X POST "$QSTASH_URL"/v2/queues/emails%3B%20id/resume ${AUTH}`,
    ]);
  });

  it("returns nothing for missing ids, other types and other kinds", () => {
    expect(lines({ kind: "sleep-schedule", resource: res("upstash-qstash-queue", null) })).toEqual(
      [],
    );
    expect(
      lines({ kind: "sleep-schedule", resource: res("upstash-qstash-queue", "qs-1/") }),
    ).toEqual([]);
    expect(
      lines({ kind: "sleep-schedule", resource: res("upstash-qstash-queue", "noslash") }),
    ).toEqual([]);
    expect(lines({ kind: "sleep-schedule", resource: res("upstash-redis", "db-1") })).toEqual([]);
    expect(
      lines({ kind: "orphan", reason: "r", resource: res("upstash-qstash-schedule", "q/s") }),
    ).toEqual([]);
  });
});
