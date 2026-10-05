import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { RemediationFinding, RemediationResource } from "@infrawrench/plugin-base";
import { redisCloudRemediationCommands } from "../remediation.js";
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
  displayName = "cache'; rm -rf ~",
): RemediationResource {
  return { resourceTypeId, displayName, externalId, fields };
}

/** One line per command; "!" marks destructive ones. */
function lines(finding: RemediationFinding): string[] {
  return redisCloudRemediationCommands(finding).map(
    (c) => `${c.destructive ? "!" : "-"} ${c.command}`,
  );
}

const orphan = (resource: RemediationResource): RemediationFinding => ({
  kind: "orphan",
  reason: "empty",
  resource,
});

describe("redisCloudRemediationCommands", () => {
  it("is wired on the plugin", () => {
    expect(plugin.remediationCommands).toBe(redisCloudRemediationCommands);
  });

  it("backs up to the configured location and deletes a Pro database", () => {
    expect(
      lines(
        orphan(
          res("rc-database", "13485723", {
            plan: "Pro",
            subscriptionId: "2189734",
            backupEnabled: true,
            savingsFlag: "empty",
          }),
        ),
      ),
    ).toMatchInlineSnapshot(`
      [
        "- curl -sS -X POST https://api.redislabs.com/v1/subscriptions/2189734/databases/13485723/backup -H "x-api-key: $REDIS_CLOUD_ACCOUNT_KEY" -H "x-api-secret-key: $REDIS_CLOUD_USER_KEY"",
        "! curl -sS -X DELETE https://api.redislabs.com/v1/subscriptions/2189734/databases/13485723 -H "x-api-key: $REDIS_CLOUD_ACCOUNT_KEY" -H "x-api-secret-key: $REDIS_CLOUD_USER_KEY"",
      ]
    `);
  });

  it("asks for an ad-hoc backup path on an Essentials database without one", () => {
    const commands = redisCloudRemediationCommands(
      orphan(
        res("rc-database", "13485724", {
          plan: "Essentials",
          subscriptionId: "2189735",
          savingsFlag: "empty",
        }),
      ),
    );
    expect(commands.map((c) => c.command)).toMatchInlineSnapshot(`
      [
        "curl -sS -X POST https://api.redislabs.com/v1/fixed/subscriptions/2189735/databases/13485724/backup -H "x-api-key: $REDIS_CLOUD_ACCOUNT_KEY" -H "x-api-secret-key: $REDIS_CLOUD_USER_KEY" -H 'Content-Type: application/json' -d "{\\"adhocBackupPath\\": \\"$REDIS_BACKUP_PATH\\"}"",
        "curl -sS -X DELETE https://api.redislabs.com/v1/fixed/subscriptions/2189735/databases/13485724 -H "x-api-key: $REDIS_CLOUD_ACCOUNT_KEY" -H "x-api-secret-key: $REDIS_CLOUD_USER_KEY"",
      ]
    `);
    expect(commands[0]?.placeholders?.map((p) => p.name)).toEqual([
      "REDIS_CLOUD_ACCOUNT_KEY",
      "REDIS_CLOUD_USER_KEY",
      "REDIS_BACKUP_PATH",
    ]);
  });

  it("returns nothing for unknown types, non-numeric ids and other kinds", () => {
    expect(lines(orphan(res("rc-subscription", "pro-2189734")))).toEqual([]);
    expect(lines(orphan(res("rc-database", "1; rm", { subscriptionId: "2189734" })))).toEqual([]);
    expect(
      lines({ kind: "sleep-schedule", resource: res("rc-database", "1", { subscriptionId: "2" }) }),
    ).toEqual([]);
  });
});
