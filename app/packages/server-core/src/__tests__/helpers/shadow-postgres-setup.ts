/**
 * Global setup for the Postgres shadow run (vitest.shadow-postgres.config.ts):
 * fail fast with a usable message when DATABASE_URL is missing or the target
 * was never migrated — otherwise every shadowed PREPARE would fail with the
 * same "relation does not exist" noise.
 */
import postgres from "postgres";

export default async function setup(): Promise<void> {
  const url = process.env["DATABASE_URL"];
  if (!url) {
    throw new Error(
      "test:postgres:shadow needs DATABASE_URL pointed at a migrated scratch database " +
        "(statements are only ever PREPAREd, never executed).",
    );
  }
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    const [row] = await sql`select to_regclass('public.organizations') as probe`;
    if (!row?.["probe"]) {
      throw new Error(
        "test:postgres:shadow found no schema at DATABASE_URL — apply migrations first " +
          "(pnpm --filter @infrawrench/web db:migrate).",
      );
    }
  } finally {
    await sql.end();
  }
}
