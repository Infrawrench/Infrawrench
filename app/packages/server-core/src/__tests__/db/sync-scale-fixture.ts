/**
 * What the sync-scale files share: a fake plugin that answers from memory, an
 * organization and account of the importing file's own, and a way to fill
 * `resources` without going through the code under test.
 *
 * The suite is several files so that each of its 70,000-row syncs can run
 * against a server of its own at the same time as the others (see
 * vitest.db.config.ts): together in one file they were most of the run.
 *
 * Nothing here reaches a provider. The mocks are registered when a test file
 * imports this module, which is before it imports the code under test: every
 * such import is dynamic, for the reason given in postgres-stores.test.ts.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { vi } from "vitest";
import type { ResourceInstance, VulnerabilityFinding } from "@infrawrench/plugin-base";

/** Past the 65,534 parameters postgres.js will bind. */
export const ROWS = 70_000;
export const TYPE = "thing";

export const orgId = `test-org-${randomUUID()}`;
export const accountId = `test-account-${randomUUID()}`;

export function rowId(index: number): string {
  return `${accountId}:${TYPE}:${index}`;
}

export function instance(index: number): ResourceInstance {
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

export function instances(from: number, to: number): ResourceInstance[] {
  return Array.from({ length: to - from }, (_, i) => instance(from + i));
}

/** What the fake plugin answers; a test sets it, and `resetProvider` empties it. */
export const provider = {
  listed: [] as ResourceInstance[],
  findings: [] as VulnerabilityFinding[],
};

export function resetProvider(): void {
  provider.listed = [];
  provider.findings = [];
}

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
        listResources: async () => provider.listed,
        listVulnerabilityFindings: async () => provider.findings,
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
vi.mock("../../analytics/writers", () => ({
  flattenMetricSeries: () => [],
  insertAccountResourceCounts: async () => undefined,
  insertDashboardStats: async () => undefined,
  insertMetricPoints: async () => undefined,
  insertPollOutcome: async () => undefined,
}));

/** `beforeAll`: the organization and its one account. */
export async function createAccount(): Promise<void> {
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
}

/** `afterAll`: the organization, everything under it, and the connection. */
export async function removeAccount(): Promise<void> {
  const { eq } = await import("drizzle-orm");
  const { db } = await import("../../db/client");
  const { organizations } = await import("../../db/schema");
  await db.delete(organizations).where(eq(organizations.id, orgId));
  await db.$client.end();
}

/** Fill the table without going through the code under test, which is the slow part. */
export async function seed(count: number): Promise<void> {
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

export async function liveIds(): Promise<Set<string>> {
  const { and, eq, isNull } = await import("drizzle-orm");
  const { db } = await import("../../db/client");
  const { resources } = await import("../../db/schema");
  const rows = await db
    .select({ id: resources.id })
    .from(resources)
    .where(and(eq(resources.accountId, accountId), isNull(resources.deletedAt)));
  return new Set(rows.map((row) => row.id));
}
