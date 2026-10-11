import { describe, expect, it } from "vitest";
import {
  deployStatusFrom,
  deployTime,
  resolveDeployEvent,
  type DeployEventsCapability,
} from "../deploy-events.js";

const row = {
  resourceTypeId: "deploy",
  externalId: "svc/1",
  displayName: "abc1234 fix",
  fields: { status: "live", finishedAt: "2026-10-01T10:00:00Z", epoch: 1_790_000_000_000 },
};

const capability: DeployEventsCapability = {
  resourceTypeIds: ["deploy"],
  toDeployEvent: (r) => ({
    kind: "deployment",
    name: "",
    environment: "production",
    repository: null,
    commitSha: "abc1234",
    commitAt: "not a date",
    deployedAt: String(r.fields["finishedAt"]),
    status: deployStatusFrom(String(r.fields["status"]), { success: ["live"], failure: [] }),
    isRollback: false,
    url: null,
  }),
};

describe("resolveDeployEvent", () => {
  it("validates and normalizes the plugin's facts", () => {
    const e = resolveDeployEvent(capability, row, null);
    expect(e).toMatchObject({
      status: "success",
      name: "abc1234 fix",
      commitAt: null,
      deployedAt: "2026-10-01T10:00:00.000Z",
    });
  });

  it("returns null for other types, throwing mappers and bad facts", () => {
    expect(resolveDeployEvent(capability, { ...row, resourceTypeId: "service" }, null)).toBeNull();
    expect(
      resolveDeployEvent(
        {
          resourceTypeIds: ["deploy"],
          toDeployEvent: () => {
            throw new Error("x");
          },
        },
        row,
        null,
      ),
    ).toBeNull();
    expect(
      resolveDeployEvent(
        {
          ...capability,
          toDeployEvent: (r) => ({ ...capability.toDeployEvent(r, null)!, deployedAt: "" }),
        },
        row,
        null,
      ),
    ).toBeNull();
    expect(resolveDeployEvent(undefined, row, null)).toBeNull();
  });

  it("reads epoch and ISO timestamps", () => {
    expect(deployTime(row, "epoch")).toBe(new Date(1_790_000_000_000).toISOString());
    expect(deployTime(row, "missing")).toBeNull();
  });
});
