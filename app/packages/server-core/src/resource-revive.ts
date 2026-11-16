/**
 * Every write that may bring a soft-deleted `resources` row back goes
 * through `deletedAtOnUpsert`: an `INSERT ... ON CONFLICT DO UPDATE` sets
 * `deleted_at` and `incarnation` from it together.
 *
 * A row that was deleted and is listed again under the same id (a sync, a
 * create, a live detail read, a desktop's push) is another resource as far
 * as anything granted to the old one is concerned: CI grants record the
 * incarnation they were made for (`ci_resource_grants.resource_incarnation`)
 * and refuse any other. A revive that left `incarnation` alone would hand the
 * old grant to the new resource.
 */
import { sql, type SQL } from "drizzle-orm";

import { resources } from "./db/schema.js";

/**
 * The `deleted_at` an upsert writes, and the `incarnation` that goes with it:
 * one more when a deleted row comes back (`next` null over a non-null
 * `deleted_at`), unchanged otherwise. Spread it into the `set` of
 * `onConflictDoUpdate` (and `deletedAt` alone into `values`).
 */
export function deletedAtOnUpsert(next: Date | null = null): {
  deletedAt: Date | null;
  incarnation: SQL;
} {
  return {
    deletedAt: next,
    incarnation:
      next === null
        ? sql`CASE WHEN ${resources.deletedAt} IS NULL THEN ${resources.incarnation} ELSE ${resources.incarnation} + 1 END`
        : sql`${resources.incarnation}`,
  };
}
