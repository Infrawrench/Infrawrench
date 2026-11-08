import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import initSqlJs, { type Database } from "sql.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DbClient } from "../client";
import { MIGRATIONS } from "../schema";
import { mergeResourceRow, mirrorEditedResourceRow, upsertResourceRow } from "../rows";
import { secretAnchorStatement } from "../secret-anchor";

/**
 * The real schema on the real engine, foreign keys on and `$n` made positional as
 * `electron/db.ts` has them, so a placeholder used twice fails here as it would there.
 */
let sqlite: Database;
const positional = (sql: string) => sql.replace(/\$\d+/g, "?");
const db: DbClient = {
  async select<T>(sql: string, params: unknown[] = []): Promise<T> {
    const stmt = sqlite.prepare(positional(sql));
    stmt.bind(params as never);
    const rows: unknown[] = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    stmt.free();
    return rows as T;
  },
  async execute(sql: string, params: unknown[] = []) {
    sqlite.run(positional(sql), params as never);
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

describe("a secret stored before anything wrote the resource's row", () => {
  const ID = "a1:thing:t:with:colons";
  const writeSecret = () =>
    db.execute(
      `INSERT INTO secret_field_states (id, resource_id, field_key, resolution_kind, encrypted_value, value_iv)
       VALUES ('s1', $1, 'token', 'literal', 'ct', 'iv')`,
      [ID],
    );
  const anchor = async () => {
    const statement = secretAnchorStatement(ID)!;
    await db.execute(statement.sql, statement.params);
  };

  it("is what the foreign key refuses", async () => {
    await expect(writeSecret()).rejects.toThrow(/FOREIGN KEY/);
  });

  it("gets a row it can hang off, listed nowhere", async () => {
    await anchor();
    await writeSecret();
    const [row] = await db.select<
      Array<{
        plugin_id: string;
        resource_type_id: string;
        external_id: string;
        deleted_at: string;
      }>
    >("SELECT plugin_id, resource_type_id, external_id, deleted_at FROM resources");
    expect(row).toMatchObject({
      plugin_id: "fake",
      resource_type_id: "thing",
      external_id: "t:with:colons",
    });
    expect(row?.deleted_at).toBeTruthy();
  });

  it("survives the create's upsert, which revives the row", async () => {
    await anchor();
    await writeSecret();
    await upsertResourceRow(db, row({ id: ID }));
    const [revived] = await db.select<Array<{ deleted_at: string | null; display_name: string }>>(
      "SELECT deleted_at, display_name FROM resources",
    );
    expect(revived).toEqual({ deleted_at: null, display_name: "Thing" });
    await expect(db.select<unknown[]>("SELECT id FROM secret_field_states")).resolves.toHaveLength(
      1,
    );
  });

  it("leaves a row that is already there alone", async () => {
    await upsertResourceRow(db, row({ id: ID, displayName: "Named" }));
    await anchor();
    const [kept] = await db.select<Array<{ display_name: string; deleted_at: string | null }>>(
      "SELECT display_name, deleted_at FROM resources",
    );
    expect(kept).toEqual({ display_name: "Named", deleted_at: null });
  });

  it("does nothing for an account that is not here, or an id that names none", async () => {
    const elsewhere = secretAnchorStatement("nope:thing:t")!;
    await db.execute(elsewhere.sql, elsewhere.params);
    await expect(db.select<unknown[]>("SELECT id FROM resources")).resolves.toEqual([]);
    expect(secretAnchorStatement("just-an-id")).toBeNull();
  });
});

describe("an edit's answer", () => {
  const fieldsOf = async (id: string) => {
    const [stored] = await db.select<Array<{ fields_json: string }>>(
      "SELECT fields_json FROM resources WHERE id = $1",
      [id],
    );
    return JSON.parse(stored!.fields_json) as Record<string, unknown>;
  };

  it("merges into the stored fields, so one the read after the edit missed is kept", async () => {
    await upsertResourceRow(db, row({ fields: { size: "s", region: "fsn1", note: "x" } }));
    await mirrorEditedResourceRow(db, "a1:thing:t", row({ fields: { size: "m", note: "" } }), "a1");
    // A field the plugin clears on purpose is an explicit value, and still applies.
    expect(await fieldsOf("a1:thing:t")).toEqual({ size: "m", region: "fsn1", note: "" });
  });

  it("moves to a new row with the old row's fields, and retires the old one", async () => {
    await upsertResourceRow(db, row({ id: "a1:thing:v1", fields: { size: "s", region: "fsn1" } }));
    await mirrorEditedResourceRow(
      db,
      "a1:thing:v1",
      row({ id: "a1:thing:v2", displayName: "v2", fields: { size: "m" } }),
      "a1",
    );
    const rows = await db.select<Array<{ id: string; display_name: string; retired: number }>>(
      "SELECT id, display_name, deleted_at IS NOT NULL AS retired FROM resources ORDER BY id",
    );
    expect(rows).toEqual([
      { id: "a1:thing:v1", display_name: "Thing", retired: 1 },
      { id: "a1:thing:v2", display_name: "v2", retired: 0 },
    ]);
    expect(await fieldsOf("a1:thing:v2")).toEqual({ size: "m", region: "fsn1" });
  });

  it("moves what was attached to the old id, and keeps what happened to it", async () => {
    await upsertResourceRow(db, row({ id: "a1:thing:v1" }));
    await upsertResourceRow(db, row({ id: "a1:other:c", resourceTypeId: "other" }));
    sqlite.run("INSERT INTO dashboards (id, name) VALUES ('d1', 'Main')");
    sqlite.run(
      "INSERT INTO dashboard_pins (id, dashboard_id, resource_id) VALUES ('p1', 'd1', 'a1:thing:v1')",
    );
    sqlite.run(
      `INSERT INTO metric_pings (id, resource_id, account_id, plugin_id, resource_type_id,
         resource_display_name, metric_label) VALUES ('m1', 'a1:thing:v1', 'a1', 'fake', 'thing', 'Thing', 'CPU')`,
    );
    sqlite.run(
      `INSERT INTO associations (id, consumer_resource_id, consumer_field_key, provider_resource_id,
         provider_output_key) VALUES ('as1', 'a1:other:c', 'host', 'a1:thing:v1', 'ip')`,
    );
    sqlite.run(
      `INSERT INTO secret_field_states (id, resource_id, field_key, resolution_kind, source_resource_id)
       VALUES ('s1', 'a1:other:c', 'host', 'output-ref', 'a1:thing:v1')`,
    );
    sqlite.run(
      "INSERT INTO posture_dismissals (id, resource_id, rule_id) VALUES ('pd1', 'a1:thing:v1', 'r')",
    );

    const next = await mirrorEditedResourceRow(
      db,
      "a1:thing:v1",
      row({ id: "a1:thing:v2", displayName: "v2" }),
      "a1",
    );

    expect(next).toBe("a1:thing:v2");
    const one = async (sql: string) => (await db.select<Array<Record<string, unknown>>>(sql))[0];
    expect(await one("SELECT resource_id FROM dashboard_pins")).toEqual({
      resource_id: "a1:thing:v2",
    });
    expect(await one("SELECT resource_id, resource_display_name FROM metric_pings")).toEqual({
      resource_id: "a1:thing:v2",
      resource_display_name: "v2",
    });
    expect(await one("SELECT provider_resource_id FROM associations")).toEqual({
      provider_resource_id: "a1:thing:v2",
    });
    expect(await one("SELECT source_resource_id FROM secret_field_states")).toEqual({
      source_resource_id: "a1:thing:v2",
    });
    expect(await one("SELECT resource_id FROM posture_dismissals")).toEqual({
      resource_id: "a1:thing:v1",
    });
  });

  it("keeps the edited id when the answer is outside the account", async () => {
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    await upsertResourceRow(db, row({ id: "a1:thing:v1" }));
    const next = await mirrorEditedResourceRow(
      db,
      "a1:thing:v1",
      row({ id: "a2:thing:v2", accountId: "a2", displayName: "v2" }),
      "a1",
    );
    expect(next).toBe("a1:thing:v1");
    const rows = await db.select<Array<{ id: string; display_name: string; retired: number }>>(
      "SELECT id, display_name, deleted_at IS NOT NULL AS retired FROM resources ORDER BY id",
    );
    expect(rows).toEqual([{ id: "a1:thing:v1", display_name: "v2", retired: 0 }]);
    quiet.mockRestore();
  });

  it("writes the answer as it is when nothing was stored", async () => {
    await mirrorEditedResourceRow(db, "a1:thing:t", row({ fields: { size: "m" } }), "a1");
    expect(await fieldsOf("a1:thing:t")).toEqual({ size: "m" });
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

describe("a read that may find the row already there", () => {
  it("merges into the stored fields, as a pin or an agent VM refresh writes", async () => {
    await upsertResourceRow(db, row({ fields: { size: "s", region: "fsn1", note: "x" } }));
    await mergeResourceRow(db, row({ displayName: "Pinned", fields: { size: "m", note: "" } }));
    const [stored] = await db.select<Array<{ fields_json: string; display_name: string }>>(
      "SELECT fields_json, display_name FROM resources",
    );
    expect(stored?.display_name).toBe("Pinned");
    expect(JSON.parse(stored!.fields_json)).toEqual({ size: "m", region: "fsn1", note: "" });
  });
});
