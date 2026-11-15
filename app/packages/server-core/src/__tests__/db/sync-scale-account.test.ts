/**
 * A sync past Postgres's bind-parameter limit (#572). postgres.js refuses a statement
 * with more than 65,534 parameters, and a fake driver cannot say what a real one binds
 * or how long the statements take, so these run against a real Postgres. Same rules as
 * postgres.test.ts: skipped unless DATABASE_URL is set, migrations already applied,
 * scratch databases only. Every import is dynamic for the reason given there.
 *
 * This file is what works on a whole account; sync-scale-type.test.ts and
 * sync-scale-soft-delete.test.ts sync one resource type. sync-scale-fixture.ts says
 * why they are apart, and holds the fake plugin: nothing here reaches a provider.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  ROWS,
  accountId,
  createAccount,
  instances,
  liveIds,
  orgId,
  provider,
  removeAccount,
  resetProvider,
  rowId,
  seed,
} from "./sync-scale-fixture";

const configured = !!process.env["DATABASE_URL"];

describe.skipIf(!configured)("an account sync past the bind-parameter limit", () => {
  beforeAll(createAccount);

  afterAll(async () => {
    if (configured) await removeAccount();
  });

  beforeEach(resetProvider);

  it("prunes an account sync that read more rows than one statement can bind", async () => {
    await seed(ROWS + 3);
    provider.listed = instances(0, ROWS);
    const { syncAccountResources } = await import("../../sync-resources");

    const result = await syncAccountResources(accountId, orgId);

    expect(result.failedTypeIds).toEqual([]);
    const live = await liveIds();
    expect(live.size).toBe(ROWS);
    expect(live.has(rowId(ROWS - 1))).toBe(true);
    expect(live.has(rowId(ROWS))).toBe(false);
  }, 900_000);

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
    provider.findings = [
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
