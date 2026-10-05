import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { RemediationFinding, RemediationResource } from "@infrawrench/plugin-base";
import { crusoeRemediationCommands } from "../remediation.js";
import { plugin } from "../plugin.js";

beforeAll(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-04T12:00:00Z"));
});
afterAll(() => {
  vi.useRealTimers();
});

const PROJECT = "3f2a1b0c-9d8e-4f7a-b6c5-d4e3f2a1b0c9";

function res(
  resourceTypeId: string,
  id: string,
  fields: RemediationResource["fields"] = {},
): RemediationResource {
  return {
    resourceTypeId,
    displayName: String(fields["name"] ?? id),
    externalId: `${PROJECT}/${id}`,
    fields,
  };
}

/** One line per command; "!" marks destructive ones. */
function lines(finding: RemediationFinding): string[] {
  return crusoeRemediationCommands(finding).map((c) => `${c.destructive ? "!" : "-"} ${c.command}`);
}

describe("crusoeRemediationCommands", () => {
  it("is wired on the plugin", () => {
    expect(plugin.remediationCommands).toBe(crusoeRemediationCommands);
  });

  it("stops and starts a VM, taking the project from the externalId", () => {
    expect(
      lines({
        kind: "sleep-schedule",
        resource: res("vm", "7c9e6679-7425-40de-944b-e07fc1f90ae7", { name: "trainer-h100-01" }),
      }),
    ).toMatchInlineSnapshot(`
      [
        "- crusoe compute vms stop trainer-h100-01 --project-id 3f2a1b0c-9d8e-4f7a-b6c5-d4e3f2a1b0c9 --yes",
        "- crusoe compute vms start trainer-h100-01 --project-id 3f2a1b0c-9d8e-4f7a-b6c5-d4e3f2a1b0c9",
      ]
    `);
  });

  it("deletes a stopped VM and a detached disk", () => {
    expect([
      ...lines({
        kind: "orphan",
        reason: "x",
        resource: res("vm", "7c9e6679-7425-40de-944b-e07fc1f90ae7", {
          name: "trainer-h100-01",
          projectId: PROJECT,
          state: "stopped",
        }),
      }),
      ...lines({
        kind: "orphan",
        reason: "x",
        resource: res("disk", "a1b2c3d4-e5f6-4789-abcd-ef0123456789", {
          name: "scratch $(id)",
          attachedVmIds: "",
        }),
      }),
    ]).toMatchInlineSnapshot(`
      [
        "! crusoe compute vms delete trainer-h100-01 --project-id 3f2a1b0c-9d8e-4f7a-b6c5-d4e3f2a1b0c9 --yes",
        "! crusoe storage disks delete 'scratch $(id)' --project-id 3f2a1b0c-9d8e-4f7a-b6c5-d4e3f2a1b0c9",
      ]
    `);
  });

  it("returns [] for unknown types, missing names, oversized and commitments", () => {
    expect(
      lines({ kind: "orphan", reason: "x", resource: res("snapshot", "s", { name: "s" }) }),
    ).toEqual([]);
    expect(lines({ kind: "orphan", reason: "x", resource: res("disk", "d") })).toEqual([]);
    expect(
      lines({
        kind: "idle-commitment",
        commitment: {
          id: "f47ac10b-58cc-4372-a567-0e02b2c3d479",
          kind: "reservation",
          description: "H100 × 64",
          scope: "acme",
          region: "us-east1-a",
        },
      }),
    ).toEqual([]);
  });
});
