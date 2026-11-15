/**
 * A sync that finds nothing where there were more rows than one statement can bind
 * (#572). Same rules as sync-scale-account.test.ts, which says what these files are
 * for.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  ROWS,
  TYPE,
  accountId,
  createAccount,
  liveIds,
  orgId,
  removeAccount,
  resetProvider,
  seed,
} from "./sync-scale-fixture";

const configured = !!process.env["DATABASE_URL"];

describe.skipIf(!configured)("a sync that empties a type past the bind-parameter limit", () => {
  beforeAll(createAccount);

  afterAll(async () => {
    if (configured) await removeAccount();
  });

  beforeEach(resetProvider);

  it("soft-deletes more rows than one statement can bind", async () => {
    await seed(ROWS);
    const { syncAccountResourceType } = await import("../../sync-resources");

    await syncAccountResourceType(accountId, orgId, TYPE);

    expect((await liveIds()).size).toBe(0);
  }, 900_000);
});
