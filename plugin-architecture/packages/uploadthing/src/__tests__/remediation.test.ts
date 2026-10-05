import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { RemediationFinding, RemediationResource } from "@infrawrench/plugin-base";
import { uploadthingRemediationCommands } from "../remediation.js";
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
  displayName = "avatar.png",
): RemediationResource {
  return { resourceTypeId, displayName, externalId, fields };
}

/** One line per command; "!" marks destructive ones. */
function lines(finding: RemediationFinding): string[] {
  return uploadthingRemediationCommands(finding).map(
    (c) => `${c.destructive ? "!" : "-"} ${c.command}`,
  );
}

const orphan = (resource: RemediationResource): RemediationFinding => ({
  kind: "orphan",
  reason: "failed upload",
  resource,
});

describe("uploadthingRemediationCommands", () => {
  it("is wired on the plugin", () => {
    expect(plugin.remediationCommands).toBe(uploadthingRemediationCommands);
  });

  it("deletes a failed upload by key", () => {
    const commands = uploadthingRemediationCommands(
      orphan(
        res("ut-file", "2e0fdb64-9957-4262-8e45-f372ba903ac8_avatar.png", {
          key: "2e0fdb64-9957-4262-8e45-f372ba903ac8_avatar.png",
          status: "Failed",
        }),
      ),
    );
    expect(commands.map((c) => c.command)).toMatchInlineSnapshot(`
      [
        "curl -sS -X POST https://api.uploadthing.com/v6/deleteFiles -H "x-uploadthing-api-key: $UPLOADTHING_API_KEY" -H 'Content-Type: application/json' -d '{"fileKeys":["2e0fdb64-9957-4262-8e45-f372ba903ac8_avatar.png"]}'",
      ]
    `);
    expect(commands[0]?.placeholders?.map((p) => p.name)).toEqual(["UPLOADTHING_API_KEY"]);
  });

  it("quotes a key containing shell metacharacters", () => {
    expect(lines(orphan(res("ut-file", "abc_it's; rm -rf ~.png")))).toMatchInlineSnapshot(`
      [
        "! curl -sS -X POST https://api.uploadthing.com/v6/deleteFiles -H "x-uploadthing-api-key: $UPLOADTHING_API_KEY" -H 'Content-Type: application/json' -d '{"fileKeys":["abc_it'"'"'s; rm -rf ~.png"]}'",
      ]
    `);
  });

  it("returns nothing for unknown types and other kinds", () => {
    expect(lines(orphan(res("ut-app", "app_123")))).toEqual([]);
    expect(lines(orphan(res("ut-file", null)))).toEqual([]);
    expect(lines({ kind: "sleep-schedule", resource: res("ut-file", "k") })).toEqual([]);
  });
});
