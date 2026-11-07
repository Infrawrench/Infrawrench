import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import initSqlJs, { type Database } from "sql.js";
import { beforeEach, describe, expect, it } from "vitest";
import type { DbClient } from "../client";
import { MIGRATIONS } from "../schema";
import { upsertResourceRow } from "../rows";

/** The real schema on the real engine, foreign keys on as `electron/db.ts` has them. */
let sqlite: Database;
const db: DbClient = {
  async select<T>(sql: string, params: unknown[] = []): Promise<T> {
    const stmt = sqlite.prepare(sql);
    stmt.bind(params as never);
    const rows: unknown[] = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    stmt.free();
    return rows as T;
  },
  async execute(sql: string, params: unknown[] = []) {
    sqlite.run(sql, params as never);
    return { rowsAffected: sqlite.getRowsModified(), lastInsertId: 0 };
  },
};

const row = (over: Partial<Parameters<typeof upsertResourceRow>[1]> = {}) => ({
  id: "a1:thing:t",
  pluginId: "fake",
  resourceTypeId: "thing",
  accountId: "a1",
  displayName: "Thing",
  fields: { size: "s" },
  resolvedOutputs: { ip: "1.2.3.4" },
  ...over,
});

beforeEach(async () => {
  const SQL = await initSqlJs();
  sqlite = new SQL.Database();
  sqlite.run("PRAGMA foreign_keys = ON");
  for (const migration of MIGRATIONS) {
    for (const stmt of migration.split(";").flatMap((s) => (s.trim() ? [s.trim()] : []))) {
      try {
        sqlite.run(stmt);
      } catch (err) {
        if (!String(err).includes("duplicate column name")) throw err;
      }
    }
  }
  sqlite.run(
    "INSERT INTO accounts (id, plugin_id, display_name, encrypted_credentials, credentials_iv) VALUES ('a1','fake','A','x','y')",
  );
});

describe("upsertResourceRow", () => {
  it("leaves what hangs off the row alone, which INSERT OR REPLACE deleted", async () => {
    await upsertResourceRow(db, row());
    sqlite.run(
      "INSERT INTO secret_field_states (id, resource_id, field_key, resolution_kind, encrypted_value, value_iv) VALUES ('s1','a1:thing:t','token','literal','ct','iv')",
    );
    await upsertResourceRow(db, row({ displayName: "Renamed" }));
    const secrets = await db.select<unknown[]>("SELECT id FROM secret_field_states");
    expect(secrets).toHaveLength(1);
    const [updated] = await db.select<Array<{ display_name: string }>>(
      "SELECT display_name FROM resources",
    );
    expect(updated?.display_name).toBe("Renamed");
  });

  it("does not forget a column the caller did not have", async () => {
    await upsertResourceRow(db, row({ parentResourceId: "a1:parent:p" }));
    const { resolvedOutputs: _outputs, ...withoutOutputs } = row();
    await upsertResourceRow(db, withoutOutputs);
    const [kept] = await db.select<Array<{ outputs_json: string; parent_resource_id: string }>>(
      "SELECT outputs_json, parent_resource_id FROM resources",
    );
    expect(kept).toEqual({
      outputs_json: JSON.stringify({ ip: "1.2.3.4" }),
      parent_resource_id: "a1:parent:p",
    });
  });

  it("revives a soft-deleted row", async () => {
    await upsertResourceRow(db, row());
    sqlite.run("UPDATE resources SET deleted_at = datetime('now')");
    await upsertResourceRow(db, row());
    const [revived] = await db.select<Array<{ deleted_at: string | null }>>(
      "SELECT deleted_at FROM resources",
    );
    expect(revived?.deleted_at).toBeNull();
  });
});

describe("the renderer", () => {
  it("never writes a resource with INSERT OR REPLACE", () => {
    const src = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
    const offenders = readdirSync(src, { recursive: true, encoding: "utf8" })
      .filter((file) => /\.tsx?$/.test(file) && !file.includes("__tests__"))
      .filter((file) =>
        /INSERT OR REPLACE INTO resources/.test(readFileSync(join(src, file), "utf8")),
      );
    expect(offenders).toEqual([]);
  });
});
