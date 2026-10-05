import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { RemediationFinding, RemediationResource } from "@infrawrench/plugin-base";
import { coreweaveRemediationCommands } from "../remediation.js";
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
  displayName = "h100-pool",
): RemediationResource {
  return { resourceTypeId, displayName, externalId, fields };
}

/** One line per command; "!" marks destructive ones. */
function lines(finding: RemediationFinding): string[] {
  return coreweaveRemediationCommands(finding).map(
    (c) => `${c.destructive ? "!" : "-"} ${c.command}`,
  );
}

const sleep = (fields: RemediationResource["fields"]): RemediationFinding => ({
  kind: "sleep-schedule",
  resource: res("node-pool", `c7e1a2b3/${String(fields["name"] ?? "")}`, fields),
});

describe("coreweaveRemediationCommands", () => {
  it("is wired on the plugin", () => {
    expect(plugin.remediationCommands).toBe(coreweaveRemediationCommands);
  });

  it("scales a fixed-size pool to zero and back", () => {
    const commands = coreweaveRemediationCommands(
      sleep({ name: "h100-pool", targetNodes: 4, autoscaling: false, state: "running" }),
    );
    expect(commands.map((c) => c.command)).toMatchInlineSnapshot(`
      [
        "kubectl --context "$KUBE_CONTEXT" scale nodepool h100-pool --replicas 0",
        "kubectl --context "$KUBE_CONTEXT" scale nodepool h100-pool --replicas 4",
      ]
    `);
    expect(commands[0]?.placeholders?.map((p) => p.name)).toEqual(["KUBE_CONTEXT"]);
  });

  it("turns the autoscaler off to stop and back on to start", () => {
    expect(
      lines(
        sleep({
          name: "h100-pool",
          targetNodes: 6,
          autoscaling: true,
          minNodes: 2,
          maxNodes: 12,
          state: "running",
        }),
      ),
    ).toMatchInlineSnapshot(`
      [
        "- kubectl --context "$KUBE_CONTEXT" patch nodepool h100-pool --type merge -p '{"spec":{"autoscaling":false,"minNodes":0,"targetNodes":0}}'",
        "- kubectl --context "$KUBE_CONTEXT" patch nodepool h100-pool --type merge -p '{"spec":{"autoscaling":true,"targetNodes":6,"minNodes":2,"maxNodes":12}}'",
      ]
    `);
  });

  it("reads the remembered size of a pool already at zero, quoting its name", () => {
    expect(lines(sleep({ name: "pool'; rm -rf ~", targetNodes: 0, state: "scaled-to-zero" })))
      .toMatchInlineSnapshot(`
      [
        "- kubectl --context "$KUBE_CONTEXT" scale nodepool 'pool'"'"'; rm -rf ~' --replicas 0",
        "- kubectl --context "$KUBE_CONTEXT" get nodepool 'pool'"'"'; rm -rf ~' -o jsonpath='{.metadata.annotations.infrawrench\\.io/restore-scale}'",
      ]
    `);
  });

  it("returns nothing for unknown types, missing names and other kinds", () => {
    expect(lines({ kind: "sleep-schedule", resource: res("cks-cluster", "c7e1a2b3") })).toEqual([]);
    expect(lines({ kind: "sleep-schedule", resource: res("node-pool", "c7e1a2b3/") })).toEqual([]);
    expect(
      lines({ kind: "orphan", reason: "x", resource: res("node-pool", "c/p", { name: "p" }) }),
    ).toEqual([]);
  });
});
