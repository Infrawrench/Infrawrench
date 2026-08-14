/**
 * Integration tests against a real Postgres. Skipped unless DATABASE_URL is
 * set (`pnpm test:postgres`); the database must already have the drizzle
 * migrations applied (`pnpm --filter @infrawrench/web db:migrate`) — the
 * docker-compose.dev.yml stack on localhost:5433 fits. Every write happens
 * inside a transaction that rolls back, so the target keeps no test rows,
 * but still: point this at a scratch database, never at production.
 *
 * These cover what the unit tests' chainable db stubs cannot: that
 * `db/schema.ts` agrees with the migrated database, and that defaults,
 * unique indexes and FK cascades actually hold server-side.
 */
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";
import * as schema from "../../db/schema";

const connectionString = process.env["DATABASE_URL"];

// Own single connection rather than db/client's pool of 10: that module
// throws at import time without DATABASE_URL, and its pool has no close
// handle, which would leave the vitest process hanging on open sockets.
const sql = connectionString ? postgres(connectionString, { max: 1, onnotice: () => {} }) : null;
const db = sql ? drizzle(sql, { schema }) : null;

type Tx = Parameters<Parameters<NonNullable<typeof db>["transaction"]>[0]>[0];

class Rollback extends Error {}

/** Run writes against the real server, then roll every one of them back. */
async function inRolledBackTransaction(run: (tx: Tx) => Promise<void>): Promise<void> {
  await db!
    .transaction(async (tx) => {
      await run(tx);
      throw new Rollback();
    })
    .catch((err) => {
      if (!(err instanceof Rollback)) throw err;
    });
}

function testOrg() {
  return { id: `test-org-${randomUUID()}`, displayName: "db integration test org" };
}

describe.skipIf(!connectionString)("postgres against a real server", () => {
  afterAll(async () => {
    await sql?.end();
  });

  it("connects and sees the migrated schema", async () => {
    // Fails loudly (missing relation) when migrations were never applied.
    await db!.select({ id: schema.organizations.id }).from(schema.organizations).limit(1);
    await db!.select({ id: schema.roles.id }).from(schema.roles).limit(1);
  });

  it("round-trips rows and applies server-side defaults", async () => {
    await inRolledBackTransaction(async (tx) => {
      const org = testOrg();
      await tx.insert(schema.organizations).values(org);

      const roleId = `test-role-${randomUUID()}`;
      await tx.insert(schema.roles).values({ id: roleId, organizationId: org.id, name: "db-test" });

      const [role] = await tx.select().from(schema.roles).where(eq(schema.roles.id, roleId));
      expect(role).toBeDefined();
      expect(role!.name).toBe("db-test");
      // Defaults declared in schema.ts must be what the server actually fills.
      expect(role!.isSystem).toBe(false);
      expect(role!.permissions).toEqual([]);
      expect(role!.createdAt).toBeInstanceOf(Date);

      const [org2] = await tx
        .select()
        .from(schema.organizations)
        .where(eq(schema.organizations.id, org.id));
      expect(org2!.complimentary).toBe(false);
      expect(org2!.chatMonthlyCapMicros).toBeNull();
    });
  });

  it("enforces unique indexes", async () => {
    const org = testOrg();
    // The violation aborts (and thereby rolls back) the whole transaction.
    await expect(
      db!.transaction(async (tx) => {
        await tx.insert(schema.organizations).values(org);
        for (const id of [`test-snip-${randomUUID()}`, `test-snip-${randomUUID()}`]) {
          await tx
            .insert(schema.sshSnippets)
            .values({ id, organizationId: org.id, name: "dup", command: "uptime" });
        }
      }),
    ).rejects.toThrow(/ssh_snippets_org_name_unique/);
  });

  it("cascades organization deletion to owned rows", async () => {
    await inRolledBackTransaction(async (tx) => {
      const org = testOrg();
      await tx.insert(schema.organizations).values(org);
      const roleId = `test-role-${randomUUID()}`;
      await tx.insert(schema.roles).values({ id: roleId, organizationId: org.id, name: "db-test" });

      await tx.delete(schema.organizations).where(eq(schema.organizations.id, org.id));

      const rows = await tx.select().from(schema.roles).where(eq(schema.roles.id, roleId));
      expect(rows).toEqual([]);
    });
  });
});
