// Local SQLite (sql.js) open/persist shared by the GUI main process and the
// headless CLI. sql.js keeps the whole database in memory and persist()
// rewrites the file, so two processes must never both write: when the CLI
// detects a running GUI instance it opens the DB read-only (persist() no-ops)
// and cloud-tokens.ts is switched to its read-only mode for the same reason.
import { app } from "electron";
import fs from "node:fs";
import path from "node:path";
import initSqlJs, { type Database as SqlJsDb, type SqlValue } from "sql.js";
import { MIGRATIONS } from "../src/db/schema";
import { setDbGetter } from "./main-utils";

let _sqlite: SqlJsDb | null = null;
let _sqlitePath: string;
let _readOnly = false;

export function setDatabaseReadOnly(readOnly: boolean): void {
  _readOnly = readOnly;
}

export function isDatabaseReadOnly(): boolean {
  return _readOnly;
}

export async function getSqlite(): Promise<SqlJsDb> {
  if (_sqlite) return _sqlite;

  const sqlJsMain = require.resolve("sql.js");
  const wasmPath = path.join(path.dirname(sqlJsMain), "sql-wasm.wasm");
  const SQL = await initSqlJs({ locateFile: () => wasmPath });

  _sqlitePath = path.join(app.getPath("userData"), "infrawrench.db");
  if (fs.existsSync(_sqlitePath)) {
    _sqlite = new SQL.Database(fs.readFileSync(_sqlitePath));
  } else {
    _sqlite = new SQL.Database();
    fs.mkdirSync(path.dirname(_sqlitePath), { recursive: true });
  }

  _sqlite.run("PRAGMA journal_mode = WAL");
  _sqlite.run("PRAGMA foreign_keys = ON");

  for (const migration of MIGRATIONS) {
    // Run each statement individually and ignore "duplicate column" errors so
    // re-running ALTER TABLE on an already-migrated DB is a no-op.
    const statements = migration.split(";").flatMap((s) => {
      const trimmed = s.trim();
      return trimmed ? [trimmed] : [];
    });
    for (const stmt of statements) {
      try {
        _sqlite.run(stmt);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes("duplicate column name")) throw err;
      }
    }
  }
  persist();

  return _sqlite;
}

export function persist(): void {
  if (!_sqlite || _readOnly) return;
  fs.writeFileSync(_sqlitePath, Buffer.from(_sqlite.export()));
}

export function normalizeSql(sql: string): string {
  return sql.replace(/\$\d+/g, "?");
}

// Registers the lazy DB getter that main-utils exposes to the rest of the
// electron code (cloud-tokens, cloud-auth, agent-setup, …).
export function wireDbGetter(): void {
  setDbGetter(async () => {
    const db = await getSqlite();
    return {
      select: async <T>(sql: string, params?: unknown[]): Promise<T> => {
        const stmt = db.prepare(normalizeSql(sql));
        const rows: Record<string, unknown>[] = [];
        stmt.bind((params ?? []) as SqlValue[]);
        while (stmt.step()) rows.push(stmt.getAsObject() as Record<string, unknown>);
        stmt.free();
        return rows as T;
      },
      execute: async (sql: string, params?: unknown[]): Promise<void> => {
        db.run(normalizeSql(sql), (params ?? []) as SqlValue[]);
        persist();
      },
    };
  });
}
