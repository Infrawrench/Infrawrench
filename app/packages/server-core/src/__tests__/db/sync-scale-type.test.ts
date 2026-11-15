/**
 * A sync of one resource type past Postgres's bind-parameter limit (#572). Same rules
 * as sync-scale-account.test.ts, which says what these files are for.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  ROWS,
  TYPE,
  accountId,
  createAccount,
  instance,
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

describe.skipIf(!configured)("a one-type sync past the bind-parameter limit", () => {
  beforeAll(createAccount);

  afterAll(async () => {
    if (configured) await removeAccount();
  });

  beforeEach(resetProvider);

  it("prunes a one-type sync that read more rows than one statement can bind", async () => {
    await seed(ROWS + 3);
    provider.listed = instances(0, ROWS);
    const { syncAccountResourceType } = await import("../../sync-resources");

    await syncAccountResourceType(accountId, orgId, TYPE);

    const live = await liveIds();
    expect(live.size).toBe(ROWS);
    expect(live.has(rowId(ROWS + 2))).toBe(false);
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
    provider.listed = [row, instance(1)];
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
});
