import { describe, it, expect } from "vitest";
import {
  computeEnvironmentDiff,
  environmentTokens,
  isIdentityChange,
  normalizeEnvironmentName,
  EnvironmentDiffPluginMismatchError,
  type EnvironmentDiffResource,
  type EnvironmentDiffSide,
} from "../environment-diff";

function resource(over: Partial<EnvironmentDiffResource> = {}): EnvironmentDiffResource {
  return {
    id: "r-1",
    resourceTypeId: "droplet",
    displayName: "api",
    externalId: "1",
    fields: {},
    ...over,
  };
}

function side(name: string, resources: EnvironmentDiffResource[]): EnvironmentDiffSide {
  return { accountId: `acct-${name}`, accountName: name, pluginId: "digitalocean", resources };
}

function diff(
  a: EnvironmentDiffSide,
  b: EnvironmentDiffSide,
  over: Partial<Parameters<typeof computeEnvironmentDiff>[0]> = {},
) {
  return computeEnvironmentDiff({ a, b, now: Date.parse("2026-01-01T00:00:00Z"), ...over });
}

describe("normalizeEnvironmentName", () => {
  const tokens = environmentTokens("Staging", "Production");

  it("strips environment words so counterparts share a key", () => {
    expect(normalizeEnvironmentName("api-staging", tokens)).toBe("api");
    expect(normalizeEnvironmentName("api-prod", tokens)).toBe("api");
  });

  it("strips the account names' own words", () => {
    const acme = environmentTokens("Acme Blue", "Acme Green");
    expect(normalizeEnvironmentName("acme-blue-worker", acme)).toBe("worker");
    expect(normalizeEnvironmentName("acme-green-worker", acme)).toBe("worker");
  });

  it("splits camelCase and keeps distinguishing suffixes", () => {
    expect(normalizeEnvironmentName("apiWorker2", tokens)).toBe("api-worker-2");
    expect(normalizeEnvironmentName("api-worker-3", tokens)).toBe("api-worker-3");
  });

  it("falls back to the plain name when stripping leaves nothing", () => {
    expect(normalizeEnvironmentName("prod", tokens)).toBe("prod");
    expect(normalizeEnvironmentName("staging", tokens)).toBe("staging");
  });
});

describe("isIdentityChange", () => {
  const refs = {
    a: { resourceId: "r-a", accountId: "acct-a", displayName: "api", externalId: "ext-a" },
    b: { resourceId: "r-b", accountId: "acct-b", displayName: "api", externalId: "ext-b" },
  };

  it("hides identifier, link and address fields", () => {
    for (const field of ["vpcId", "vpc_id", "arn", "outputs.endpoint", "publicIPAddress", "url"]) {
      expect(isIdentityChange({ field, from: "x", to: "y" }, refs)).toBe(true);
    }
  });

  it("hides timestamps on both sides", () => {
    expect(
      isIdentityChange(
        { field: "createdAt", from: "2025-01-01T00:00:00Z", to: "2026-02-03T04:05:06Z" },
        refs,
      ),
    ).toBe(true);
    expect(isIdentityChange({ field: "launchTime", from: 1, to: 2 }, refs)).toBe(true);
  });

  it("hides each side's own provider id", () => {
    expect(isIdentityChange({ field: "slug", from: "ext-a", to: "ext-b" }, refs)).toBe(true);
  });

  it("keeps configuration, including fields whose names merely end in those letters", () => {
    for (const change of [
      { field: "instanceClass", from: "db.t3.micro", to: "db.r5.large" },
      { field: "engineVersion", from: "15.4", to: "14.9" },
      { field: "deletionProtection", from: true, to: false },
      { field: "valid", from: "yes", to: "no" },
      { field: "region", from: "nyc3", to: "fra1" },
      { field: "size", from: 2, to: 4 },
    ]) {
      expect(isIdentityChange(change, refs)).toBe(false);
    }
  });
});

describe("computeEnvironmentDiff", () => {
  it("refuses to compare accounts from different plugins", () => {
    const a = side("staging", []);
    const b = { ...side("prod", []), pluginId: "aws" };
    expect(() => diff(a, b)).toThrow(EnvironmentDiffPluginMismatchError);
  });

  it("reports resources present on only one side", () => {
    const result = diff(
      side("staging", [resource({ id: "s-1", displayName: "api-staging" })]),
      side("prod", [
        resource({ id: "p-1", displayName: "api-prod" }),
        resource({ id: "p-2", displayName: "worker-prod" }),
      ]),
    );
    expect(result.totals).toMatchObject({ onlyInA: 0, onlyInB: 1, changed: 0, identical: 1 });
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]).toMatchObject({
      status: "only-in-b",
      a: null,
      b: { resourceId: "p-2", displayName: "worker-prod" },
    });
  });

  it("reports a resource type present in one environment and not the other", () => {
    const result = diff(
      side("staging", [resource({ id: "s-1", resourceTypeId: "redis", displayName: "cache" })]),
      side("prod", [resource({ id: "p-1", resourceTypeId: "droplet", displayName: "api" })]),
    );
    const redis = result.types.find((t) => t.resourceTypeId === "redis");
    const droplet = result.types.find((t) => t.resourceTypeId === "droplet");
    expect(redis).toMatchObject({ countA: 1, countB: 0, delta: -1, missingFrom: "b" });
    expect(droplet).toMatchObject({ countA: 0, countB: 1, delta: 1, missingFrom: "a" });
    expect(result.totals).toMatchObject({ typesOnlyInA: 1, typesOnlyInB: 1 });
  });

  it("counts per-type deltas when both sides hold the type", () => {
    const result = diff(
      side("staging", [
        resource({ id: "s-1", displayName: "web-1" }),
        resource({ id: "s-2", displayName: "web-2" }),
      ]),
      side("prod", [
        resource({ id: "p-1", displayName: "web-1" }),
        resource({ id: "p-2", displayName: "web-2" }),
        resource({ id: "p-3", displayName: "web-3" }),
      ]),
    );
    expect(result.types).toHaveLength(1);
    expect(result.types[0]).toMatchObject({
      countA: 2,
      countB: 3,
      delta: 1,
      onlyInB: 1,
      identical: 2,
      missingFrom: null,
    });
  });

  it("surfaces field divergence between matched counterparts", () => {
    const result = diff(
      side("staging", [
        resource({
          id: "s-1",
          resourceTypeId: "pg",
          displayName: "main-staging",
          fields: { size: "db-s-1vcpu-1gb", version: "15", ha: false },
        }),
      ]),
      side("prod", [
        resource({
          id: "p-1",
          resourceTypeId: "pg",
          displayName: "main-prod",
          fields: { size: "db-s-4vcpu-8gb", version: "15", ha: true },
        }),
      ]),
      { resourceTypeNames: { pg: "Postgres Cluster" } },
    );
    expect(result.totals.changed).toBe(1);
    expect(result.entries[0]).toMatchObject({
      status: "changed",
      resourceTypeName: "Postgres Cluster",
      a: { resourceId: "s-1" },
      b: { resourceId: "p-1" },
    });
    expect(result.entries[0]?.changes).toEqual([
      { field: "size", a: "db-s-1vcpu-1gb", b: "db-s-4vcpu-8gb" },
      { field: "ha", a: false, b: true },
    ]);
  });

  it("never reports the display name a pair was matched despite", () => {
    const result = diff(
      side("staging", [resource({ id: "s-1", displayName: "api-staging" })]),
      side("prod", [resource({ id: "p-1", displayName: "api-prod" })]),
    );
    expect(result.entries).toEqual([]);
    expect(result.totals).toMatchObject({ changed: 0, identical: 1 });
  });

  it("hides identity divergence by default and counts what it hid", () => {
    const staging = side("staging", [
      resource({
        id: "s-1",
        externalId: "111",
        fields: { vpcId: "vpc-a", createdAt: "2025-01-01T00:00:00Z", size: "s-1vcpu" },
      }),
    ]);
    const prod = side("prod", [
      resource({
        id: "p-1",
        externalId: "222",
        fields: { vpcId: "vpc-b", createdAt: "2026-01-01T00:00:00Z", size: "s-4vcpu" },
      }),
    ]);

    const filtered = diff(staging, prod);
    expect(filtered.entries[0]?.changes.map((c) => c.field)).toEqual(["size"]);
    expect(filtered.entries[0]?.suppressedCount).toBe(2);
    expect(filtered.totals.suppressedFieldChanges).toBe(2);
    expect(filtered.includeIdentityFields).toBe(false);

    const unfiltered = diff(staging, prod, { includeIdentityFields: true });
    expect(unfiltered.entries[0]?.changes.map((c) => c.field)).toEqual([
      "vpcId",
      "createdAt",
      "size",
    ]);
    expect(unfiltered.totals.suppressedFieldChanges).toBe(0);
  });

  it("counts a pair whose every divergence was identity noise as identical", () => {
    const result = diff(
      side("staging", [resource({ id: "s-1", fields: { instanceId: "i-a" } })]),
      side("prod", [resource({ id: "p-1", fields: { instanceId: "i-b" } })]),
    );
    expect(result.entries).toEqual([]);
    expect(result.totals).toMatchObject({ changed: 0, identical: 1, suppressedFieldChanges: 1 });
  });

  it("compares resolved outputs under an outputs. prefix", () => {
    const result = diff(
      side("staging", [resource({ id: "s-1", fields: {}, outputs: { tier: "basic" } })]),
      side("prod", [resource({ id: "p-1", fields: {}, outputs: { tier: "premium" } })]),
      { includeIdentityFields: false },
    );
    expect(result.entries[0]?.changes).toEqual([
      { field: "outputs.tier", a: "basic", b: "premium" },
    ]);
  });

  it("pairs same-named resources up to the overlap and leaves the rest unmatched", () => {
    const result = diff(
      side("staging", [
        resource({ id: "s-1", displayName: "data", externalId: "1", fields: { gb: 10 } }),
        resource({ id: "s-2", displayName: "data", externalId: "2", fields: { gb: 20 } }),
      ]),
      side("prod", [
        resource({ id: "p-1", displayName: "data", externalId: "9", fields: { gb: 10 } }),
      ]),
    );
    expect(result.totals).toMatchObject({ onlyInA: 1, onlyInB: 0, changed: 0, identical: 1 });
    expect(result.entries[0]).toMatchObject({ status: "only-in-a", a: { resourceId: "s-2" } });
  });

  it("restricts the comparison to one resource type when asked", () => {
    const result = diff(
      side("staging", [
        resource({ id: "s-1", resourceTypeId: "droplet", displayName: "api" }),
        resource({ id: "s-2", resourceTypeId: "volume", displayName: "data" }),
      ]),
      side("prod", [resource({ id: "p-1", resourceTypeId: "droplet", displayName: "api" })]),
      { resourceTypeId: "volume" },
    );
    expect(result.types.map((t) => t.resourceTypeId)).toEqual(["volume"]);
    expect(result.totals).toMatchObject({ onlyInA: 1, onlyInB: 0 });
    expect(result.a.resourceCount).toBe(1);
  });

  it("is deterministic and does not depend on input order", () => {
    const forwards = diff(
      side("staging", [
        resource({ id: "s-1", displayName: "b" }),
        resource({ id: "s-2", displayName: "a" }),
      ]),
      side("prod", [resource({ id: "p-1", displayName: "a" })]),
    );
    const backwards = diff(
      side("staging", [
        resource({ id: "s-2", displayName: "a" }),
        resource({ id: "s-1", displayName: "b" }),
      ]),
      side("prod", [resource({ id: "p-1", displayName: "a" })]),
    );
    expect(forwards.entries).toEqual(backwards.entries);
  });

  it("tolerates a stored bag that isn't an object", () => {
    const result = diff(
      side("staging", [resource({ id: "s-1", fields: null })]),
      side("prod", [resource({ id: "p-1", fields: "not-a-bag" })]),
    );
    expect(result.entries).toEqual([]);
    expect(result.totals.identical).toBe(1);
  });
});
