/**
 * A sync past Postgres's bind-parameter limit (#572). postgres.js refuses a statement
 * with more than 65,534 parameters, and a fake driver cannot say what a real one binds
 * or how long the statements take, so these run against a real Postgres. Same rules as
 * postgres.test.ts: skipped unless DATABASE_URL is set, migrations already applied,
 * scratch databases only. Every import is dynamic for the reason given there.
 *
 * Nothing here reaches a provider: the plugin is a fake that answers from memory.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ResourceInstance, VulnerabilityFinding } from "@infrawrench/plugin-base";

const configured = !!process.env["DATABASE_URL"];

/** Past the 65,534 parameters postgres.js will bind. */
const ROWS = 70_000;
const TYPE = "thing";

const orgId = `test-org-${randomUUID()}`;
const accountId = `test-account-${randomUUID()}`;

function rowId(index: number): string {
  return `${accountId}:${TYPE}:${index}`;
}

function instance(index: number): ResourceInstance {
  return {
    id: rowId(index),
    pluginId: "fake",
    resourceTypeId: TYPE,
    accountId,
    displayName: `Thing ${index}`,
    externalId: String(index),
    fields: {},
    resolvedOutputs: {},
    secretStates: [],
    createdAt: "",
    updatedAt: "",
  };
}

function instances(from: number, to: number): ResourceInstance[] {
  return Array.from({ length: to - from }, (_, i) => instance(from + i));
}

let listed: ResourceInstance[] = [];
let findings: VulnerabilityFinding[] = [];

vi.mock("../../plugin-loader", () => ({
  getPlugin: async () => ({
    plugin: {
      manifest: {
        id: "fake",
        egressHosts: [],
        credentialFields: [],
        vulnerabilities: { label: "Scanner" },
      },
      resourceTypes: [{ id: TYPE, name: "Thing", fields: [], outputs: [] }],
      createClient: () => ({
        listResources: async () => listed,
        listVulnerabilityFindings: async () => findings,
      }),
    },
  }),
  loadPlugins: async () => [],
}));
vi.mock("../../provider-oauth", () => ({ decryptAccountCredentials: async () => ({}) }));
vi.mock("../../tunnel-resolver", () => ({
  rewriteCredentialsThroughTunnel: async () => undefined,
}));
vi.mock("../../host-services", () => ({ buildPluginHostServices: async () => ({}) }));
vi.mock("../../clickhouse/writers", () => ({
  flattenMetricSeries: () => [],
  insertAccountResourceCounts: async () => undefined,
  insertDashboardStats: async () => undefined,
  insertMetricPoints: async () => undefined,
  insertPollOutcome: async () => undefined,
}));

describe.skipIf(!configured)("a sync past the bind-parameter limit", () => {
  beforeAll(async () => {
    process.env["ENCRYPTION_MASTER_KEY"] ??= randomBytes(32).toString("base64");
    const { db } = await import("../../db/client");
    const { accounts, organizations } = await import("../../db/schema");
    await db.insert(organizations).values({ id: orgId, displayName: "Sync scale" });
    await db.insert(accounts).values({
      id: accountId,
      organizationId: orgId,
      pluginId: "fake",
      displayName: "Fake",
      encryptedCredentials: "x",
      credentialsIv: "y",
    });
  });

  afterAll(async () => {
    if (!configured) return;
    const { eq } = await import("drizzle-orm");
    const { db } = await import("../../db/client");
    const { organizations } = await import("../../db/schema");
    await db.delete(organizations).where(eq(organizations.id, orgId));
    await db.$client.end();
  });

  /** Fill the table without going through the code under test, which is the slow part. */
  async function seed(count: number): Promise<void> {
    const { eq, sql } = await import("drizzle-orm");
    const { db } = await import("../../db/client");
    const { resources } = await import("../../db/schema");
    await db.delete(resources).where(eq(resources.accountId, accountId));
    await db.execute(sql`
      INSERT INTO resources (id, organization_id, plugin_id, resource_type_id, account_id,
                             display_name, external_id, last_synced_at, sync_version)
      SELECT ${accountId} || ':' || ${TYPE} || ':' || g, ${orgId}, 'fake', ${TYPE}, ${accountId},
             'Thing ' || g, g::text, now(), 1
      FROM generate_series(0, ${count - 1}::int) AS g`);
  }

  async function liveIds(): Promise<Set<string>> {
    const { and, eq, isNull } = await import("drizzle-orm");
    const { db } = await import("../../db/client");
    const { resources } = await import("../../db/schema");
    const rows = await db
      .select({ id: resources.id })
      .from(resources)
      .where(and(eq(resources.accountId, accountId), isNull(resources.deletedAt)));
    return new Set(rows.map((row) => row.id));
  }

  beforeEach(() => {
    listed = [];
    findings = [];
  });

  it("prunes an account sync that read more rows than one statement can bind", async () => {
    await seed(ROWS + 3);
    listed = instances(0, ROWS);
    const { syncAccountResources } = await import("../../sync-resources");

    const result = await syncAccountResources(accountId, orgId);

    expect(result.failedTypeIds).toEqual([]);
    const live = await liveIds();
    expect(live.size).toBe(ROWS);
    expect(live.has(rowId(ROWS - 1))).toBe(true);
    expect(live.has(rowId(ROWS))).toBe(false);
  }, 900_000);

  it("prunes a one-type sync that read more rows than one statement can bind", async () => {
    await seed(ROWS + 3);
    listed = instances(0, ROWS);
    const { syncAccountResourceType } = await import("../../sync-resources");

    await syncAccountResourceType(accountId, orgId, TYPE);

    const live = await liveIds();
    expect(live.size).toBe(ROWS);
    expect(live.has(rowId(ROWS + 2))).toBe(false);
  }, 900_000);

  it("soft-deletes more rows than one statement can bind", async () => {
    await seed(ROWS);
    const { syncAccountResourceType } = await import("../../sync-resources");

    await syncAccountResourceType(accountId, orgId, TYPE);

    expect((await liveIds()).size).toBe(0);
  }, 900_000);

  it("keeps what a repeat sync wrote, with a version that moved on", async () => {
    const { and, eq, max } = await import("drizzle-orm");
    const { db } = await import("../../db/client");
    const { resources } = await import("../../db/schema");
    await seed(1);
    await db
      .update(resources)
      .set({ fieldsJson: { kept: "user supplied", overwritten: "old" } })
      .where(eq(resources.id, rowId(0)));
    const row = instance(0);
    row.displayName = "Renamed";
    row.fields = { overwritten: "new" };
    listed = [row, instance(1)];
    const { syncAccountResourceType } = await import("../../sync-resources");

    await syncAccountResourceType(accountId, orgId, TYPE);

    const [stored] = await db
      .select()
      .from(resources)
      .where(and(eq(resources.id, rowId(0)), eq(resources.accountId, accountId)));
    expect(stored!.displayName).toBe("Renamed");
    expect(stored!.fieldsJson).toEqual({ kept: "user supplied", overwritten: "new" });
    expect(stored!.syncVersion).toBeGreaterThan(1);
    expect(stored!.deletedAt).toBeNull();
    const [highest] = await db
      .select({ version: max(resources.syncVersion) })
      .from(resources)
      .where(eq(resources.organizationId, orgId));
    expect(stored!.syncVersion).toBe(highest!.version);
  });

  it("resolves more findings at once than one insert can bind", async () => {
    const { eq, sql } = await import("drizzle-orm");
    const { db } = await import("../../db/client");
    const { accountVulnerabilityFindings, vulnerabilityResolutions } =
      await import("../../db/schema");
    // Eleven parameters a resolution, so 6,500 of them pass 65,534 in one insert.
    await db.execute(sql`
      INSERT INTO account_vulnerability_findings
        (id, organization_id, account_id, plugin_id, finding_id, advisory_id, severity,
         artifact_kind, artifact_name)
      SELECT gen_random_uuid()::text, ${orgId}, ${accountId}, 'fake', 'finding-' || g, 'CVE-1',
             'high', 'image', 'repo/app'
      FROM generate_series(1, 6500) AS g`);
    findings = [
      {
        id: "finding-1",
        advisoryId: "CVE-1",
        severity: "high",
        artifact: { kind: "image", name: "repo/app" },
      },
    ];
    const { collectAccountVulnerabilities } = await import("../../vulnerabilities/collect");

    await collectAccountVulnerabilities(accountId, orgId);

    const left = await db
      .select({ id: accountVulnerabilityFindings.findingId })
      .from(accountVulnerabilityFindings)
      .where(eq(accountVulnerabilityFindings.accountId, accountId));
    expect(left.map((row) => row.id)).toEqual(["finding-1"]);
    const resolved = await db
      .select({ id: vulnerabilityResolutions.id })
      .from(vulnerabilityResolutions)
      .where(eq(vulnerabilityResolutions.accountId, accountId));
    expect(resolved).toHaveLength(6499);
  }, 900_000);
});
