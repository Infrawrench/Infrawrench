import { describe, expect, it } from "vitest";

import {
  computeBackupCoverage,
  formatHours,
  riskyBackupFindings,
  validateBackupPolicyInput,
  type BackupPolicy,
  type BackupScanInput,
  type BackupScanResource,
} from "../backups";

const NOW = Date.parse("2026-08-01T12:00:00.000Z");
const HOUR = 3_600_000;

function policy(overrides: Partial<BackupPolicy> = {}): BackupPolicy {
  return {
    id: "p-1",
    name: "Daily",
    resourceTypeIds: [],
    tagKey: null,
    tagValue: null,
    maxRpoHours: 24,
    minRetentionDays: null,
    enabled: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function res(overrides: Partial<BackupScanResource> & { id: string }): BackupScanResource {
  return {
    pluginId: "do",
    resourceTypeId: "volume",
    accountId: "acc-1",
    displayName: overrides.id,
    externalId: overrides.id,
    fields: {},
    ...overrides,
  };
}

/**
 * A workspace with one snapshot type protecting one volume type, plus whatever
 * rows the case supplies. Mirrors the DigitalOcean shape: `snapshot.resourceId`
 * names the volume's external id.
 */
function scan(resources: BackupScanResource[], policies: BackupPolicy[] = []): BackupScanInput {
  return {
    plugins: [
      {
        id: "do",
        displayName: "DigitalOcean",
        resourceTypes: [
          {
            id: "snapshot",
            displayName: "Snapshot",
            backupRole: { role: "snapshot", sourceKey: "resourceId", sizeKey: "sizeGb" },
          },
          {
            id: "volume",
            displayName: "Volume",
            backupPolicy: { protectedBy: ["snapshot"] },
          },
          {
            id: "droplet",
            displayName: "Droplet",
            backupPolicy: {
              protectedBy: ["snapshot"],
              automatedBackupFieldKey: "nextBackupStart",
              automatedBackupWhen: "present",
            },
          },
        ],
      },
    ],
    accounts: [{ id: "acc-1", displayName: "Prod", pluginId: "do" }],
    resources,
    policies,
  };
}

function snapshot(id: string, sourceId: string, agoHours: number, sizeGb?: number) {
  return res({
    id,
    resourceTypeId: "snapshot",
    fields: {
      resourceId: sourceId,
      createdAt: new Date(NOW - agoHours * HOUR).toISOString(),
      ...(sizeGb === undefined ? {} : { sizeGb }),
    },
  });
}

describe("computeBackupCoverage", () => {
  it("returns an empty feed when no type declares anything", () => {
    const feed = computeBackupCoverage(
      {
        plugins: [{ id: "do", displayName: "DO", resourceTypes: [{ id: "x", displayName: "X" }] }],
        accounts: [{ id: "acc-1", displayName: "Prod", pluginId: "do" }],
        resources: [res({ id: "r-1", resourceTypeId: "x" })],
      },
      { now: NOW },
    );
    expect(feed.findings).toEqual([]);
    expect(feed.resources).toEqual([]);
    expect(feed.generatedAt).toBe("2026-08-01T12:00:00.000Z");
  });

  it("flags a stateful resource with nothing protecting it", () => {
    const feed = computeBackupCoverage(scan([res({ id: "vol-1" })]), { now: NOW });
    expect(feed.findings).toHaveLength(1);
    expect(feed.findings[0]?.kind).toBe("unprotected");
    // No policy selects it, so this is a fact rather than a broken promise.
    expect(feed.findings[0]?.severity).toBe("medium");
    expect(feed.summary.unprotectedCount).toBe(1);
    expect(feed.summary.statefulCount).toBe(1);
  });

  it("escalates an unprotected resource that a policy selects", () => {
    const feed = computeBackupCoverage(scan([res({ id: "vol-1" })], [policy()]), { now: NOW });
    expect(feed.findings[0]?.severity).toBe("high");
    expect(feed.findings[0]?.policyName).toBe("Daily");
  });

  it("counts a fresh snapshot as protection and reports the RPO", () => {
    const feed = computeBackupCoverage(
      scan([res({ id: "vol-1" }), snapshot("snap-1", "vol-1", 3)], [policy()]),
      { now: NOW },
    );
    expect(feed.findings).toEqual([]);
    const row = feed.resources[0];
    expect(row?.state).toBe("protected");
    expect(row?.backupCount).toBe(1);
    expect(row?.rpoHours).toBeCloseTo(3);
    expect(row?.latestBackupId).toBe("snap-1");
    expect(feed.summary.worstRpoHours).toBeCloseTo(3);
  });

  it("breaches the RPO when the newest backup is too old, and uses the newest", () => {
    const feed = computeBackupCoverage(
      scan(
        [res({ id: "vol-1" }), snapshot("old", "vol-1", 200), snapshot("newer", "vol-1", 40)],
        [policy({ maxRpoHours: 24 })],
      ),
      { now: NOW },
    );
    expect(feed.findings).toHaveLength(1);
    expect(feed.findings[0]?.kind).toBe("rpo-breach");
    expect(feed.findings[0]?.latestBackupId).toBe("newer");
    expect(feed.findings[0]?.rpoHours).toBeCloseTo(40);
    // 40h against a 24h objective is under 2x, so it stays medium.
    expect(feed.findings[0]?.severity).toBe("medium");
  });

  it("escalates an RPO breached by more than double", () => {
    const feed = computeBackupCoverage(
      scan([res({ id: "vol-1" }), snapshot("old", "vol-1", 100)], [policy({ maxRpoHours: 24 })]),
      { now: NOW },
    );
    expect(feed.findings[0]?.severity).toBe("high");
  });

  it("never satisfies an RPO with an undatable backup, but still counts it", () => {
    const undated = res({
      id: "snap-1",
      resourceTypeId: "snapshot",
      fields: { resourceId: "vol-1" },
    });
    const feed = computeBackupCoverage(scan([res({ id: "vol-1" }), undated], [policy()]), {
      now: NOW,
    });
    expect(feed.findings).toHaveLength(1);
    expect(feed.findings[0]?.kind).toBe("rpo-breach");
    expect(feed.resources[0]?.backupCount).toBe(1);
    expect(feed.resources[0]?.rpoHours).toBeNull();
  });

  it("reads a backup with no policy and no timestamp as protected, not stale", () => {
    const undated = res({
      id: "snap-1",
      resourceTypeId: "snapshot",
      fields: { resourceId: "vol-1" },
    });
    const feed = computeBackupCoverage(scan([res({ id: "vol-1" }), undated]), { now: NOW });
    expect(feed.findings).toEqual([]);
    expect(feed.resources[0]?.state).toBe("protected");
  });

  it("takes the strictest RPO across the policies that select a resource", () => {
    const feed = computeBackupCoverage(
      scan(
        [res({ id: "vol-1" }), snapshot("snap", "vol-1", 12)],
        [policy({ id: "loose", maxRpoHours: 48 }), policy({ id: "tight", maxRpoHours: 6 })],
      ),
      { now: NOW },
    );
    expect(feed.findings).toHaveLength(1);
    expect(feed.findings[0]?.maxRpoHours).toBe(6);
    expect(feed.findings[0]?.policyId).toBe("tight");
    expect(feed.resources[0]?.rpoPolicyId).toBe("tight");
  });

  it("names the policy that supplies each objective, not just the RPO winner", () => {
    // The regression this guards: one `policy` variable held whichever policy
    // won the RPO race, so a retention finding cited an unrelated policy — and
    // the reader would have gone to edit the wrong one. The two strictest
    // demands routinely come from different policies, which is exactly the
    // "everything, 24h" plus "prod databases, 30 days" setup below.
    const input: BackupScanInput = {
      plugins: [
        {
          id: "azure",
          displayName: "Azure",
          resourceTypes: [
            {
              id: "pg",
              displayName: "PostgreSQL",
              backupPolicy: { protectedBy: [], retentionDaysFieldKey: "backupRetentionDays" },
            },
          ],
        },
      ],
      accounts: [{ id: "acc-1", displayName: "Prod", pluginId: "azure" }],
      resources: [
        res({
          id: "pg-1",
          pluginId: "azure",
          resourceTypeId: "pg",
          fields: { backupRetentionDays: 3 },
        }),
      ],
      policies: [
        policy({ id: "rpo-only", name: "Fleet RPO", maxRpoHours: 24, minRetentionDays: null }),
        policy({
          id: "retention-only",
          name: "Database retention",
          maxRpoHours: null,
          minRetentionDays: 30,
        }),
      ],
    };
    const feed = computeBackupCoverage(input, { now: NOW });

    const retention = feed.findings.find((f) => f.kind === "retention-below-policy");
    expect(retention?.policyId).toBe("retention-only");
    expect(retention?.policyName).toBe("Database retention");
    expect(retention?.minRetentionDays).toBe(30);
    // And the sentence a human reads must name it too, not the RPO policy.
    expect(retention?.detail).toContain("Database retention");
    expect(retention?.detail).not.toContain("Fleet RPO");

    const row = feed.resources[0];
    expect(row?.rpoPolicyId).toBe("rpo-only");
    expect(row?.retentionPolicyId).toBe("retention-only");
  });

  it("names the RPO policy on an RPO breach when another policy sets retention", () => {
    const feed = computeBackupCoverage(
      scan(
        [res({ id: "vol-1" }), snapshot("snap", "vol-1", 100)],
        [
          policy({ id: "rpo-only", name: "Fleet RPO", maxRpoHours: 24, minRetentionDays: null }),
          policy({
            id: "retention-only",
            name: "Volume retention",
            maxRpoHours: null,
            minRetentionDays: 14,
          }),
        ],
      ),
      { now: NOW },
    );
    const breach = feed.findings.find((f) => f.kind === "rpo-breach");
    expect(breach?.policyId).toBe("rpo-only");
    expect(breach?.detail).toContain("Fleet RPO");
    expect(breach?.detail).not.toContain("Volume retention");
  });

  it("ignores disabled policies", () => {
    const feed = computeBackupCoverage(
      scan([res({ id: "vol-1" }), snapshot("snap", "vol-1", 200)], [policy({ enabled: false })]),
      { now: NOW },
    );
    expect(feed.findings).toEqual([]);
  });

  it("narrows by resource type", () => {
    const feed = computeBackupCoverage(
      scan([res({ id: "vol-1" })], [policy({ resourceTypeIds: ["droplet"] })]),
      { now: NOW },
    );
    // Still unprotected, but not under a policy — so medium, not high.
    expect(feed.findings[0]?.severity).toBe("medium");
    expect(feed.findings[0]?.policyId).toBeNull();
  });

  it("narrows by tag, matching keys case-insensitively and values exactly", () => {
    const tagged = res({ id: "vol-1", fields: { tags: { Env: "prod" } } });
    const selected = computeBackupCoverage(
      scan([tagged], [policy({ tagKey: "env", tagValue: "prod" })]),
      { now: NOW },
    );
    expect(selected.findings[0]?.policyId).toBe("p-1");

    const wrongValue = computeBackupCoverage(
      scan([tagged], [policy({ tagKey: "env", tagValue: "staging" })]),
      { now: NOW },
    );
    expect(wrongValue.findings[0]?.policyId).toBeNull();

    const untagged = computeBackupCoverage(
      scan([res({ id: "vol-2" })], [policy({ tagKey: "env" })]),
      { now: NOW },
    );
    expect(untagged.findings[0]?.policyId).toBeNull();
  });

  describe("automated backups", () => {
    function droplet(nextBackupStart: unknown) {
      return res({ id: "d-1", resourceTypeId: "droplet", fields: { nextBackupStart } });
    }

    it("clears a resource whose provider-native backups are on", () => {
      const feed = computeBackupCoverage(scan([droplet("2026-08-02T00:00:00Z")]), { now: NOW });
      expect(feed.findings).toEqual([]);
      expect(feed.resources[0]?.state).toBe("automated");
      expect(feed.resources[0]?.automatedBackups).toBe(true);
    });

    it("flags one whose backups are explicitly off", () => {
      const feed = computeBackupCoverage(scan([droplet("")]), { now: NOW });
      expect(feed.findings[0]?.kind).toBe("unprotected");
      expect(feed.resources[0]?.automatedBackups).toBe(false);
    });

    it("reports an unreadable field as unknown, never as a gap", () => {
      // The regression this guards: `parseFlag` returning null used to fall
      // through to `unprotected`, inventing a gap that reached the digest.
      // A row synced before its plugin declared the field is a resource we
      // have not assessed, not a resource with no backup.
      const feed = computeBackupCoverage(scan([res({ id: "d-1", resourceTypeId: "droplet" })]), {
        now: NOW,
      });
      expect(feed.resources[0]?.automatedBackups).toBeNull();
      expect(feed.resources[0]?.state).toBe("unknown");
      expect(feed.findings).toEqual([]);
      expect(feed.summary.unknownCount).toBe(1);
      expect(feed.summary.unprotectedCount).toBe(0);
      expect(feed.summary.protectedCount).toBe(0);
      expect(feed.summary.statefulCount).toBe(1);
    });

    it("does not swallow a real gap on a type with no automated-backup signal", () => {
      // The other side of the same fix. A type declaring only `protectedBy` is
      // saying snapshots are the only protection it has, so no snapshot is a
      // confirmed gap — over-correcting to "unknown" here would silently empty
      // the feature for volumes, servers, branches and databases.
      const feed = computeBackupCoverage(scan([res({ id: "vol-1" })]), { now: NOW });
      expect(feed.resources[0]?.state).toBe("unprotected");
      expect(feed.findings[0]?.kind).toBe("unprotected");
      expect(feed.summary.unprotectedCount).toBe(1);
      expect(feed.summary.unknownCount).toBe(0);
    });

    it("still confirms a gap when the field is readable and says off", () => {
      const feed = computeBackupCoverage(
        scan([res({ id: "d-1", resourceTypeId: "droplet", fields: { nextBackupStart: "" } })]),
        { now: NOW },
      );
      expect(feed.resources[0]?.state).toBe("unprotected");
      expect(feed.summary.unknownCount).toBe(0);
      expect(feed.summary.unprotectedCount).toBe(1);
    });

    it("keeps unknown resources out of the digest's risk counts", () => {
      // `riskyBackupFindings` and `kindCounts.unprotected` are what the weekly
      // digest reports; an unassessed resource must not appear in either.
      const feed = computeBackupCoverage(
        scan([
          res({ id: "d-1", resourceTypeId: "droplet" }),
          res({ id: "d-2", resourceTypeId: "droplet", fields: { nextBackupStart: "" } }),
        ]),
        { now: NOW },
      );
      expect(feed.kindCounts.unprotected).toBe(1);
      expect(riskyBackupFindings(feed)).toHaveLength(1);
      expect(riskyBackupFindings(feed)[0]?.resourceId).toBe("d-2");
    });

    it("reads a positive retention window as proof backups are on", () => {
      const input: BackupScanInput = {
        plugins: [
          {
            id: "azure",
            displayName: "Azure",
            resourceTypes: [
              {
                id: "pg",
                displayName: "PostgreSQL",
                backupPolicy: { protectedBy: [], retentionDaysFieldKey: "backupRetentionDays" },
              },
            ],
          },
        ],
        accounts: [{ id: "acc-1", displayName: "Prod", pluginId: "azure" }],
        resources: [
          res({
            id: "pg-1",
            pluginId: "azure",
            resourceTypeId: "pg",
            fields: { backupRetentionDays: 7 },
          }),
        ],
        policies: [policy({ maxRpoHours: null, minRetentionDays: 30 })],
      };
      const feed = computeBackupCoverage(input, { now: NOW });
      expect(feed.resources[0]?.state).toBe("automated");
      expect(feed.findings).toHaveLength(1);
      expect(feed.findings[0]?.kind).toBe("retention-below-policy");
      expect(feed.findings[0]?.retentionDays).toBe(7);
      expect(feed.findings[0]?.minRetentionDays).toBe(30);
      expect(feed.findings[0]?.severity).toBe("medium");
    });

    it("treats a retention of zero as backups disabled", () => {
      const input: BackupScanInput = {
        plugins: [
          {
            id: "azure",
            displayName: "Azure",
            resourceTypes: [
              {
                id: "pg",
                displayName: "PostgreSQL",
                backupPolicy: { protectedBy: [], retentionDaysFieldKey: "backupRetentionDays" },
              },
            ],
          },
        ],
        accounts: [{ id: "acc-1", displayName: "Prod", pluginId: "azure" }],
        resources: [
          res({
            id: "pg-1",
            pluginId: "azure",
            resourceTypeId: "pg",
            fields: { backupRetentionDays: 0 },
          }),
        ],
        policies: [policy({ maxRpoHours: null, minRetentionDays: 7 })],
      };
      const feed = computeBackupCoverage(input, { now: NOW });
      expect(feed.resources[0]?.automatedBackups).toBe(false);
      expect(feed.findings.map((f) => f.kind).sort()).toEqual([
        "retention-below-policy",
        "unprotected",
      ]);
      expect(feed.findings.find((f) => f.kind === "retention-below-policy")?.severity).toBe("high");
    });
  });

  describe("orphans", () => {
    it("flags a backup whose source is gone, with its size", () => {
      const feed = computeBackupCoverage(scan([snapshot("snap-1", "vol-gone", 5, 40)]), {
        now: NOW,
      });
      expect(feed.findings).toHaveLength(1);
      expect(feed.findings[0]?.kind).toBe("orphaned-snapshot");
      expect(feed.findings[0]?.severity).toBe("low");
      expect(feed.findings[0]?.sizeGb).toBe(40);
      expect(feed.summary.orphanedBackupCount).toBe(1);
      expect(feed.summary.orphanedGb).toBe(40);
    });

    it("never claims an orphan when the source field is empty", () => {
      const undirected = res({
        id: "snap-1",
        resourceTypeId: "snapshot",
        fields: { resourceId: "" },
      });
      const feed = computeBackupCoverage(scan([undirected]), { now: NOW });
      expect(feed.findings).toEqual([]);
      expect(feed.summary.unattributableBackupCount).toBe(1);
      expect(feed.summary.orphanedBackupCount).toBe(0);
    });

    it("never claims an orphan when two resources answer to the source value", () => {
      const feed = computeBackupCoverage(
        scan([
          res({ id: "a", externalId: "shared", displayName: "a" }),
          res({ id: "b", externalId: "shared", displayName: "b" }),
          snapshot("snap-1", "shared", 5),
        ]),
        { now: NOW },
      );
      expect(feed.findings.filter((f) => f.kind === "orphaned-snapshot")).toEqual([]);
      expect(feed.summary.unattributableBackupCount).toBe(1);
    });

    it("joins cost data when it is supplied, and drops a mixed-currency total", () => {
      const priced = computeBackupCoverage(scan([snapshot("snap-1", "gone", 5, 10)]), {
        now: NOW,
        costsByResource: new Map([["acc-1 snap-1", { amount: 3.5, currency: "USD" }]]),
      });
      expect(priced.findings[0]?.monthlyCost).toBe(3.5);
      expect(priced.summary.orphanedMonthlyCost).toBe(3.5);
      expect(priced.summary.currency).toBe("USD");

      const mixed = computeBackupCoverage(
        scan([snapshot("snap-1", "gone", 5), snapshot("snap-2", "gone", 5)]),
        {
          now: NOW,
          costsByResource: new Map([
            ["acc-1 snap-1", { amount: 3.5, currency: "USD" }],
            ["acc-1 snap-2", { amount: 2, currency: "EUR" }],
          ]),
        },
      );
      expect(mixed.summary.orphanedMonthlyCost).toBeNull();
      expect(mixed.summary.currency).toBeNull();
    });

    it("leaves the cost null rather than zero when billing data is missing", () => {
      const feed = computeBackupCoverage(scan([snapshot("snap-1", "gone", 5)]), { now: NOW });
      expect(feed.findings[0]?.monthlyCost).toBeNull();
      expect(feed.summary.orphanedMonthlyCost).toBeNull();
    });
  });

  describe("declaration options", () => {
    function templated(resources: BackupScanResource[]): BackupScanInput {
      return {
        plugins: [
          {
            id: "ps",
            displayName: "PlanetScale",
            resourceTypes: [
              {
                id: "ps-backup",
                displayName: "Backup",
                backupRole: {
                  role: "snapshot",
                  sourceTemplate: "{databaseName}/{branchName}",
                  createdKey: "createdAt",
                  sizeKey: "size",
                  sizeUnit: "bytes",
                },
              },
              {
                id: "ps-branch",
                displayName: "Branch",
                backupPolicy: { protectedBy: ["ps-backup"] },
              },
            ],
          },
        ],
        accounts: [{ id: "acc-1", displayName: "Prod", pluginId: "ps" }],
        resources,
      };
    }

    it("composes a source out of a template, so same-named branches don't collide", () => {
      const feed = computeBackupCoverage(
        templated([
          res({ id: "b1", pluginId: "ps", resourceTypeId: "ps-branch", externalId: "app/main" }),
          res({ id: "b2", pluginId: "ps", resourceTypeId: "ps-branch", externalId: "other/main" }),
          res({
            id: "bk",
            pluginId: "ps",
            resourceTypeId: "ps-backup",
            fields: {
              databaseName: "app",
              branchName: "main",
              createdAt: new Date(NOW - 2 * HOUR).toISOString(),
              size: 2 * 1024 ** 3,
            },
          }),
        ]),
        { now: NOW },
      );
      const app = feed.resources.find((r) => r.resourceId === "b1");
      const other = feed.resources.find((r) => r.resourceId === "b2");
      expect(app?.backupCount).toBe(1);
      expect(other?.backupCount).toBe(0);
      expect(feed.summary.orphanedBackupCount).toBe(0);
    });

    it("treats a template with an empty half as unattributable, not orphaned", () => {
      const feed = computeBackupCoverage(
        templated([
          res({
            id: "bk",
            pluginId: "ps",
            resourceTypeId: "ps-backup",
            fields: { databaseName: "app", branchName: "" },
          }),
        ]),
        { now: NOW },
      );
      expect(feed.summary.unattributableBackupCount).toBe(1);
      expect(feed.summary.orphanedBackupCount).toBe(0);
    });

    it("converts a byte-denominated size", () => {
      const feed = computeBackupCoverage(
        templated([
          res({
            id: "bk",
            pluginId: "ps",
            resourceTypeId: "ps-backup",
            fields: { databaseName: "gone", branchName: "main", size: 3 * 1024 ** 3 },
          }),
        ]),
        { now: NOW },
      );
      expect(feed.summary.orphanedGb).toBeCloseTo(3);
    });

    it("skips rows the backupTypeKey narrowing excludes", () => {
      const input: BackupScanInput = {
        plugins: [
          {
            id: "hetzner",
            displayName: "Hetzner",
            resourceTypes: [
              {
                id: "image",
                displayName: "Image",
                backupRole: {
                  role: "snapshot",
                  backupTypeKey: "type",
                  backupTypeValues: ["backup", "snapshot"],
                  sourceKey: "boundTo",
                },
              },
              { id: "server", displayName: "Server", backupPolicy: { protectedBy: ["image"] } },
            ],
          },
        ],
        accounts: [{ id: "acc-1", displayName: "Prod", pluginId: "hetzner" }],
        resources: [
          res({
            id: "ubuntu",
            pluginId: "hetzner",
            resourceTypeId: "image",
            fields: { type: "system", boundTo: "" },
          }),
          res({
            id: "bk",
            pluginId: "hetzner",
            resourceTypeId: "image",
            fields: { type: "Backup", boundTo: "srv-1", createdAt: new Date(NOW).toISOString() },
          }),
          res({ id: "srv-1", pluginId: "hetzner", resourceTypeId: "server" }),
        ],
      };
      const feed = computeBackupCoverage(input, { now: NOW });
      // The public Ubuntu image is not counted at all.
      expect(feed.summary.backupCount).toBe(1);
      expect(feed.summary.unattributableBackupCount).toBe(0);
      expect(feed.resources[0]?.backupCount).toBe(1);
    });
  });

  it("scopes the join to the account, so staging cannot claim production's snapshots", () => {
    const feed = computeBackupCoverage(
      {
        ...scan([]),
        accounts: [
          { id: "acc-1", displayName: "Prod", pluginId: "do" },
          { id: "acc-2", displayName: "Staging", pluginId: "do" },
        ],
        resources: [
          res({ id: "vol-prod", accountId: "acc-1", externalId: "data" }),
          res({
            id: "snap-staging",
            accountId: "acc-2",
            resourceTypeId: "snapshot",
            fields: { resourceId: "data", createdAt: new Date(NOW).toISOString() },
          }),
        ],
      },
      { now: NOW },
    );
    expect(feed.resources.find((r) => r.resourceId === "vol-prod")?.backupCount).toBe(0);
    expect(feed.summary.orphanedBackupCount).toBe(1);
  });

  it("skips resources whose account is gone", () => {
    const feed = computeBackupCoverage(
      { ...scan([res({ id: "vol-1", accountId: "missing" })]), accounts: [] },
      { now: NOW },
    );
    expect(feed.resources).toEqual([]);
    expect(feed.findings).toEqual([]);
  });

  it("sorts findings worst first and counts them by severity and kind", () => {
    const feed = computeBackupCoverage(
      scan(
        [res({ id: "vol-1" }), snapshot("orphan", "gone", 5)],
        [policy({ resourceTypeIds: ["volume"] })],
      ),
      { now: NOW },
    );
    expect(feed.findings.map((f) => f.kind)).toEqual(["unprotected", "orphaned-snapshot"]);
    expect(feed.counts).toEqual({ critical: 0, high: 1, medium: 0, low: 1 });
    expect(feed.kindCounts.unprotected).toBe(1);
    expect(feed.kindCounts["orphaned-snapshot"]).toBe(1);
    expect(feed.totalCount).toBe(2);
  });
});

describe("riskyBackupFindings", () => {
  it("drops orphans — they are spend, not risk", () => {
    const feed = computeBackupCoverage(scan([res({ id: "vol-1" }), snapshot("o", "gone", 1)]), {
      now: NOW,
    });
    expect(riskyBackupFindings(feed).map((f) => f.kind)).toEqual(["unprotected"]);
  });
});

describe("formatHours", () => {
  it("scales from minutes to days", () => {
    expect(formatHours(0.5)).toBe("30 minutes");
    expect(formatHours(1)).toBe("1 hour");
    expect(formatHours(6)).toBe("6 hours");
    expect(formatHours(72)).toBe("3 days");
  });
});

describe("validateBackupPolicyInput", () => {
  it("accepts a policy that demands something", () => {
    expect(validateBackupPolicyInput({ name: "Daily", maxRpoHours: 24 })).toBeNull();
    expect(validateBackupPolicyInput({ name: "Retain", minRetentionDays: 7 })).toBeNull();
  });

  it("rejects a policy that demands nothing", () => {
    expect(validateBackupPolicyInput({ name: "Empty" })).toMatch(/must set an RPO/);
  });

  it("rejects a nameless policy", () => {
    expect(validateBackupPolicyInput({ name: "  ", maxRpoHours: 24 })).toMatch(/needs a name/);
  });

  it("rejects out-of-range and non-integer bounds", () => {
    expect(validateBackupPolicyInput({ name: "x", maxRpoHours: 0 })).toMatch(/maxRpoHours/);
    expect(validateBackupPolicyInput({ name: "x", maxRpoHours: 1.5 })).toMatch(/whole number/);
    expect(validateBackupPolicyInput({ name: "x", minRetentionDays: 99_999 })).toMatch(
      /minRetentionDays/,
    );
  });

  it("rejects a tag value with no tag key", () => {
    expect(validateBackupPolicyInput({ name: "x", maxRpoHours: 24, tagValue: "prod" })).toMatch(
      /needs a tag key/,
    );
  });
});
