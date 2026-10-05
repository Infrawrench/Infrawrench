import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { RemediationFinding, RemediationResource } from "@infrawrench/plugin-base";
import { linodeRemediationCommands } from "../remediation.js";
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
  return {
    resourceTypeId,
    displayName: String(fields["label"] ?? "web-1"),
    externalId,
    fields,
  };
}

/** One line per command; "!" marks destructive ones. */
function lines(finding: RemediationFinding): string[] {
  return linodeRemediationCommands(finding).map((c) => `${c.destructive ? "!" : "-"} ${c.command}`);
}

const orphan = (resource: RemediationResource): RemediationFinding => ({
  kind: "orphan",
  reason: "unused",
  resource,
});

describe("linodeRemediationCommands", () => {
  it("is wired on the plugin", () => {
    expect(plugin.remediationCommands).toBe(linodeRemediationCommands);
  });

  it("resizes an oversized Linode", () => {
    expect(
      lines({
        kind: "oversized",
        resource: res("linode", "51234567", { type: "g6-standard-4", region: "us-east" }),
        sizeFieldKey: "type",
        currentSize: "g6-standard-4",
        targetSize: "g6-standard-2",
        region: "us-east",
      }),
    ).toMatchInlineSnapshot(`
      [
        "- linode-cli linodes resize 51234567 --type g6-standard-2",
      ]
    `);
  });

  it("shuts down and boots a Linode, and suspends and resumes a database", () => {
    expect([
      ...lines({ kind: "sleep-schedule", resource: res("linode", "51234567") }),
      ...lines({
        kind: "sleep-schedule",
        resource: res("database", "postgresql/129834", { engine: "postgresql" }),
      }),
    ]).toMatchInlineSnapshot(`
      [
        "- linode-cli linodes shutdown 51234567",
        "- linode-cli linodes boot 51234567",
        "- linode-cli databases postgresql-suspend 129834",
        "- linode-cli databases postgresql-resume 129834",
      ]
    `);
  });

  it("clones before deleting a volume, trimming and quoting the label", () => {
    const cmds = linodeRemediationCommands(
      orphan(res("volume", "887766", { label: "pg data'; rm -rf ~ long label", linodeId: "" })),
    );
    expect(cmds.map((c) => `${c.destructive ? "!" : "-"} ${c.command}`)).toMatchInlineSnapshot(`
      [
        "- linode-cli volumes clone 887766 --label 'pg data'"'"'; rm-pre-delete-20261004'",
        "! linode-cli volumes delete 887766",
      ]
    `);
  });

  it("images, then deletes a powered-off Linode", () => {
    const cmds = linodeRemediationCommands(
      orphan(res("linode", "51234567", { label: "old-worker", status: "offline" })),
    );
    expect(cmds.map((c) => `${c.destructive ? "!" : "-"} ${c.command}`)).toMatchInlineSnapshot(`
      [
        "- linode-cli linodes disks-list 51234567",
        "- linode-cli images create --disk_id "$LINODE_DISK_ID" --label old-worker-pre-delete-20261004",
        "! linode-cli linodes delete 51234567",
      ]
    `);
    expect(cmds[1]?.placeholders?.[0]?.name).toBe("LINODE_DISK_ID");
  });

  it("releases a reserved IP and deletes an empty NodeBalancer", () => {
    expect([
      ...lines(orphan(res("reserved-ip", "192.0.2.141", { address: "192.0.2.141" }))),
      ...lines(orphan(res("nodebalancer", "40311", { nodeCount: 0 }))),
    ]).toMatchInlineSnapshot(`
      [
        "! linode-cli networking reserved-ip-delete 192.0.2.141",
        "! linode-cli nodebalancers delete 40311",
      ]
    `);
  });

  it("returns [] for unknown types, missing ids and commitments", () => {
    expect(lines(orphan(res("bucket", "us-east/b")))).toEqual([]);
    expect(lines(orphan(res("volume", null)))).toEqual([]);
    expect(lines({ kind: "sleep-schedule", resource: res("database", "redis/1") })).toEqual([]);
    expect(
      lines({
        kind: "idle-commitment",
        commitment: { id: "c", kind: "reservation", description: "", scope: null, region: null },
      }),
    ).toEqual([]);
  });
});
