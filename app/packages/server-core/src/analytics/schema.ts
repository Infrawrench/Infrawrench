/**
 * The analytics tables, re-exported for the readers and writers in this
 * directory. They are ordinary Postgres tables defined in
 * `../db/analytics-schema.ts` (so drizzle-kit generates their migrations with
 * everything else); the commentary on keys, rollups and retention lives there.
 */
export * from "../db/analytics-schema";
