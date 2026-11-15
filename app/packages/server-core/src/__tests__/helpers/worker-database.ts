/**
 * Setup file of vitest.db.config.ts: with DATABASE_URLS set, this worker's
 * DATABASE_URL becomes the server in that list that is its own. Vitest
 * numbers the workers that run at the same time from 1 to `maxWorkers`
 * (VITEST_POOL_ID), which the config sets to the number of servers, and gives
 * a number to another file only once the file that had it has finished. So no
 * two files are ever on one server at once.
 *
 * It runs before the test file is loaded, which matters: the suites read
 * DATABASE_URL as they load, and `db/client` on its first query.
 */
const servers = (process.env["DATABASE_URLS"] ?? "")
  .split(",")
  .map((url) => url.trim())
  .filter(Boolean);

if (servers.length > 0) {
  const worker = Number(process.env["VITEST_POOL_ID"]);
  const server = servers[worker - 1];
  // Sharing a server instead would pass most of the time and prove nothing.
  if (!server) {
    throw new Error(
      `DATABASE_URLS lists ${servers.length} servers and this is worker ` +
        `${process.env["VITEST_POOL_ID"] ?? "(no VITEST_POOL_ID)"}: no server is its own`,
    );
  }
  process.env["DATABASE_URL"] = server;
}
