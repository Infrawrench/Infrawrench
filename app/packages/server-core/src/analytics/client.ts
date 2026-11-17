import { db, type Db } from "../db/client";

/**
 * The Drizzle handle every reader and writer in this directory queries through.
 *
 * The analytics tables are ordinary Postgres tables, so this is the same `db`
 * the rest of the server uses (the request-scoped handle on the edge, the
 * process pool elsewhere). It is a function rather than a re-export so the
 * readers keep one seam that tests can replace with `vi.mock("./client")`.
 */
export type AnalyticsDb = Db;

export function getAnalyticsDb(): AnalyticsDb {
  return db;
}
