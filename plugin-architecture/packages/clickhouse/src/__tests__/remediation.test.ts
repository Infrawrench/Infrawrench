import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { RemediationFinding, RemediationResource } from "@infrawrench/plugin-base";
import { clickhouseRemediationCommands } from "../remediation.js";
import { plugin } from "../plugin.js";

beforeAll(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-04T12:00:00Z"));
});
afterAll(() => {
  vi.useRealTimers();
});

const SERVICE = "4d2c6b1e-7a5f-4f6e-9b3a-2c1d0e9f8a7b";

function res(
  resourceTypeId: string,
  externalId: string | null,
  fields: RemediationResource["fields"] = {},
  displayName = "analytics",
): RemediationResource {
  return { resourceTypeId, displayName, externalId, fields };
}

/** One line per command; "!" marks destructive ones. */
function lines(finding: RemediationFinding): string[] {
  return clickhouseRemediationCommands(finding).map(
    (c) => `${c.destructive ? "!" : "-"} ${c.command}`,
  );
}

describe("clickhouseRemediationCommands", () => {
  it("is wired on the plugin", () => {
    expect(plugin.remediationCommands).toBe(clickhouseRemediationCommands);
  });

  it("stops and starts a service", () => {
    const commands = clickhouseRemediationCommands({
      kind: "sleep-schedule",
      resource: res("ch-service", SERVICE, { serviceId: SERVICE, state: "running" }),
    });
    expect(commands.map((c) => c.command)).toMatchInlineSnapshot(`
      [
        "curl -sS -X PATCH "https://api.clickhouse.cloud/v1/organizations/$CLICKHOUSE_ORG_ID/services/4d2c6b1e-7a5f-4f6e-9b3a-2c1d0e9f8a7b/state" -u "$CLICKHOUSE_KEY_ID:$CLICKHOUSE_KEY_SECRET" -H 'Content-Type: application/json' -d '{"command":"stop"}'",
        "curl -sS -X PATCH "https://api.clickhouse.cloud/v1/organizations/$CLICKHOUSE_ORG_ID/services/4d2c6b1e-7a5f-4f6e-9b3a-2c1d0e9f8a7b/state" -u "$CLICKHOUSE_KEY_ID:$CLICKHOUSE_KEY_SECRET" -H 'Content-Type: application/json' -d '{"command":"start"}'",
      ]
    `);
    expect(commands[0]?.placeholders?.map((p) => p.name)).toEqual([
      "CLICKHOUSE_ORG_ID",
      "CLICKHOUSE_KEY_ID",
      "CLICKHOUSE_KEY_SECRET",
    ]);
  });

  it("stops and starts a ClickPipe", () => {
    expect(
      lines({
        kind: "sleep-schedule",
        resource: res("ch-clickpipe", `${SERVICE}/9e8d7c6b-5a4f-4e3d-8c2b-1a0f9e8d7c6b`, {
          serviceId: SERVICE,
          clickPipeId: "9e8d7c6b-5a4f-4e3d-8c2b-1a0f9e8d7c6b",
          state: "Running",
        }),
      }),
    ).toMatchInlineSnapshot(`
      [
        "- curl -sS -X PATCH "https://api.clickhouse.cloud/v1/organizations/$CLICKHOUSE_ORG_ID/services/4d2c6b1e-7a5f-4f6e-9b3a-2c1d0e9f8a7b/clickpipes/9e8d7c6b-5a4f-4e3d-8c2b-1a0f9e8d7c6b/state" -u "$CLICKHOUSE_KEY_ID:$CLICKHOUSE_KEY_SECRET" -H 'Content-Type: application/json' -d '{"command":"stop"}'",
        "- curl -sS -X PATCH "https://api.clickhouse.cloud/v1/organizations/$CLICKHOUSE_ORG_ID/services/4d2c6b1e-7a5f-4f6e-9b3a-2c1d0e9f8a7b/clickpipes/9e8d7c6b-5a4f-4e3d-8c2b-1a0f9e8d7c6b/state" -u "$CLICKHOUSE_KEY_ID:$CLICKHOUSE_KEY_SECRET" -H 'Content-Type: application/json' -d '{"command":"start"}'",
      ]
    `);
  });

  it("percent-encodes ids so they cannot break out of the URL", () => {
    expect(lines({ kind: "sleep-schedule", resource: res("ch-service", 'x"; rm -rf ~ $HOME') }))
      .toMatchInlineSnapshot(`
      [
        "- curl -sS -X PATCH "https://api.clickhouse.cloud/v1/organizations/$CLICKHOUSE_ORG_ID/services/x%22%3B%20rm%20-rf%20~%20%24HOME/state" -u "$CLICKHOUSE_KEY_ID:$CLICKHOUSE_KEY_SECRET" -H 'Content-Type: application/json' -d '{"command":"stop"}'",
        "- curl -sS -X PATCH "https://api.clickhouse.cloud/v1/organizations/$CLICKHOUSE_ORG_ID/services/x%22%3B%20rm%20-rf%20~%20%24HOME/state" -u "$CLICKHOUSE_KEY_ID:$CLICKHOUSE_KEY_SECRET" -H 'Content-Type: application/json' -d '{"command":"start"}'",
      ]
    `);
  });

  it("returns nothing for unknown types and other kinds", () => {
    expect(lines({ kind: "sleep-schedule", resource: res("ch-backup", "b-1") })).toEqual([]);
    expect(lines({ kind: "orphan", reason: "x", resource: res("ch-service", SERVICE) })).toEqual(
      [],
    );
  });
});
