import { describe, expect, it, vi } from "vitest";

// The module imports the db client for `recordResourceChanges`; the pure diff
// functions under test never touch it.
vi.mock("../db/client", () => ({ db: {} }));
vi.mock("../db/schema", () => ({ resourceChanges: {} }));

import { computeResourceChangeEvents, diffResourceRecords } from "../resource-changes";
import type { PriorResourceSnapshot } from "../resource-changes";

function prior(over: Partial<PriorResourceSnapshot> = {}): PriorResourceSnapshot {
  return {
    id: "aws:acc-1:i-1",
    pluginId: "aws",
    resourceTypeId: "vm",
    displayName: "web-1",
    fieldsJson: { status: "running", size: "t3.micro" },
    outputsJson: { ip: "1.2.3.4" },
    deletedAt: null,
    ...over,
  };
}

function fetched(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: "aws:acc-1:i-1",
    pluginId: "aws",
    resourceTypeId: "vm",
    accountId: "acc-1",
    displayName: "web-1",
    fields: { status: "running", size: "t3.micro" },
    resolvedOutputs: { ip: "1.2.3.4" },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ...over,
  } as any;
}

describe("diffResourceRecords", () => {
  it("returns no changes for identical snapshots", () => {
    expect(diffResourceRecords(prior(), fetched())).toEqual([]);
  });

  it("detects displayName, field, and output changes", () => {
    const diff = diffResourceRecords(
      prior(),
      fetched({
        displayName: "web-1-renamed",
        fields: { status: "stopped", size: "t3.micro" },
        resolvedOutputs: { ip: "5.6.7.8" },
      }),
    );
    expect(diff).toEqual([
      { field: "displayName", from: "web-1", to: "web-1-renamed" },
      { field: "status", from: "running", to: "stopped" },
      { field: "outputs.ip", from: "1.2.3.4", to: "5.6.7.8" },
    ]);
  });

  it("reports a newly appearing field with a null `from`", () => {
    const diff = diffResourceRecords(
      prior(),
      fetched({ fields: { status: "running", size: "t3.micro", region: "eu-west-1" } }),
    );
    expect(diff).toEqual([{ field: "region", from: null, to: "eu-west-1" }]);
  });

  it("does not report fields the lister stopped returning (upsert merge semantics)", () => {
    // The upsert merges JSON, so a key missing from the fetch survives in the
    // DB — it must not read as removed.
    const diff = diffResourceRecords(prior(), fetched({ fields: { status: "running" } }));
    expect(diff).toEqual([]);
  });

  it("compares objects structurally regardless of key order", () => {
    const diff = diffResourceRecords(
      prior({ fieldsJson: { tags: { env: "prod", team: "core" } } }),
      fetched({ fields: { tags: { team: "core", env: "prod" } } }),
    );
    expect(diff).toEqual([]);
  });
});

describe("computeResourceChangeEvents", () => {
  it("emits created for a resource with no prior row", () => {
    const events = computeResourceChangeEvents({
      prior: [],
      fetched: [fetched()],
      deletableTypeIds: ["vm"],
    });
    expect(events).toEqual([
      expect.objectContaining({ resourceId: "aws:acc-1:i-1", changeKind: "created", diff: [] }),
    ]);
  });

  it("emits created for a resource that reappears after soft-deletion", () => {
    const events = computeResourceChangeEvents({
      prior: [prior({ deletedAt: new Date() })],
      fetched: [fetched()],
      deletableTypeIds: ["vm"],
    });
    expect(events.map((e) => e.changeKind)).toEqual(["created"]);
  });

  it("emits updated with a diff when a stored field changed", () => {
    const events = computeResourceChangeEvents({
      prior: [prior()],
      fetched: [fetched({ fields: { status: "stopped", size: "t3.micro" } })],
      deletableTypeIds: ["vm"],
    });
    expect(events).toEqual([
      expect.objectContaining({
        changeKind: "updated",
        diff: [{ field: "status", from: "running", to: "stopped" }],
      }),
    ]);
  });

  it("emits nothing when nothing changed", () => {
    const events = computeResourceChangeEvents({
      prior: [prior()],
      fetched: [fetched()],
      deletableTypeIds: ["vm"],
    });
    expect(events).toEqual([]);
  });

  it("emits deleted only for types whose list succeeded", () => {
    const goneVm = prior();
    const goneDb = prior({ id: "aws:acc-1:db-1", resourceTypeId: "db", displayName: "orders" });
    const events = computeResourceChangeEvents({
      prior: [goneVm, goneDb],
      fetched: [],
      deletableTypeIds: ["vm"], // "db" list failed this cycle
    });
    expect(events).toEqual([
      expect.objectContaining({ resourceId: "aws:acc-1:i-1", changeKind: "deleted" }),
    ]);
  });

  it("never emits deleted for rows already soft-deleted", () => {
    const events = computeResourceChangeEvents({
      prior: [prior({ deletedAt: new Date() })],
      fetched: [],
      deletableTypeIds: ["vm"],
    });
    expect(events).toEqual([]);
  });
});
