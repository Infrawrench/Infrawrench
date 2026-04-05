import { app, BrowserWindow, ipcMain } from "electron";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import initSqlJs, { type Database as SqlJsDb } from "sql.js";
import { Pool as PgPool } from "pg";
import mysql from "mysql2/promise";
import { MIGRATIONS } from "../src/db/schema";

// ── Window ────────────────────────────────────────────────────────────────────

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    titleBarStyle: "hiddenInset",
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (process.env["ELECTRON_RENDERER_URL"]) {
    win.loadURL(process.env["ELECTRON_RENDERER_URL"]);
    win.webContents.openDevTools();
  } else {
    win.loadFile(path.join(__dirname, "../../index.html"));
  }
}

app.whenReady().then(() => {
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

// ── Encryption key ────────────────────────────────────────────────────────────

let _encryptionKey: Buffer | null = null;

function getEncryptionKey(): Buffer {
  if (_encryptionKey) return _encryptionKey;
  const keyPath = path.join(app.getPath("userData"), "master.key");
  if (fs.existsSync(keyPath)) {
    _encryptionKey = Buffer.from(fs.readFileSync(keyPath, "utf8"), "base64");
  } else {
    _encryptionKey = crypto.randomBytes(32);
    fs.mkdirSync(path.dirname(keyPath), { recursive: true });
    fs.writeFileSync(keyPath, _encryptionKey.toString("base64"), "utf8");
  }
  return _encryptionKey;
}

ipcMain.handle("get_or_create_encryption_key", () =>
  getEncryptionKey().toString("base64"),
);

ipcMain.handle("encrypt_value", (_e, { plaintext }: { plaintext: string }) => {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    ciphertext: Buffer.concat([encrypted, tag]).toString("base64"),
    iv: iv.toString("base64"),
  };
});

ipcMain.handle("decrypt_value", (_e, { ciphertext, iv }: { ciphertext: string; iv: string }) => {
  const key = getEncryptionKey();
  const data = Buffer.from(ciphertext, "base64");
  const ivBuf = Buffer.from(iv, "base64");
  const tag = data.subarray(-16);
  const encrypted = data.subarray(0, -16);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, ivBuf);
  decipher.setAuthTag(tag);
  return decipher.update(encrypted).toString("utf8") + decipher.final("utf8");
});

// ── SQLite via sql.js (pure WASM — no native module compilation needed) ───────

let _sqlite: SqlJsDb | null = null;
let _sqlitePath: string;

async function getSqlite(): Promise<SqlJsDb> {
  if (_sqlite) return _sqlite;

  // Locate the WASM file next to the sql.js JS bundle
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
    _sqlite.run(migration);
  }
  persist();

  return _sqlite;
}

function persist() {
  if (!_sqlite) return;
  fs.writeFileSync(_sqlitePath, Buffer.from(_sqlite.export()));
}

// Tauri SQL plugin used $1, $2 positional params — sql.js uses ?
function normalizeSql(sql: string): string {
  return sql.replace(/\$\d+/g, "?");
}

ipcMain.handle("db_select", async (_e, { sql, params }: { sql: string; params?: unknown[] }) => {
  const db = await getSqlite();
  const stmt = db.prepare(normalizeSql(sql));
  const rows: Record<string, unknown>[] = [];
  stmt.bind(params ?? []);
  while (stmt.step()) rows.push(stmt.getAsObject() as Record<string, unknown>);
  stmt.free();
  return rows;
});

ipcMain.handle("db_execute", async (_e, { sql, params }: { sql: string; params?: unknown[] }) => {
  const db = await getSqlite();
  db.run(normalizeSql(sql), params ?? []);
  const rowsAffected = db.getRowsModified();
  persist();
  return { rowsAffected, lastInsertId: 0 };
});

// ── Generic SQL (external databases via real Node.js drivers) ─────────────────

function detectDriver(cs: string): "postgres" | "mysql" {
  if (cs.startsWith("postgres://") || cs.startsWith("postgresql://")) return "postgres";
  if (cs.startsWith("mysql://")) return "mysql";
  throw new Error(`Cannot detect SQL driver from scheme: ${cs.split("://")[0]}`);
}

function sanitizePgUrl(cs: string): string {
  try {
    const u = new URL(cs);
    u.searchParams.delete("channel_binding");
    return u.toString();
  } catch {
    return cs;
  }
}

ipcMain.handle("sql_query", async (_e, { connectionString, sql }: { connectionString: string; sql: string }) => {
  const driver = detectDriver(connectionString);

  if (driver === "postgres") {
    const pool = new PgPool({ connectionString: sanitizePgUrl(connectionString), max: 1 });
    try {
      return (await pool.query(sql)).rows;
    } finally {
      await pool.end();
    }
  }

  const conn = await mysql.createConnection(connectionString);
  try {
    const [rows] = await conn.query(sql);
    return rows;
  } finally {
    await conn.end();
  }
});

ipcMain.handle("sql_execute", async (_e, {
  connectionString, sql, params,
}: { connectionString: string; sql: string; params?: unknown[] }) => {
  const driver = detectDriver(connectionString);
  const p = params ?? [];

  if (driver === "postgres") {
    const pool = new PgPool({ connectionString: sanitizePgUrl(connectionString), max: 1 });
    try {
      return (await pool.query(sql, p)).rowCount ?? 0;
    } finally {
      await pool.end();
    }
  }

  const conn = await mysql.createConnection(connectionString);
  try {
    const [result] = await conn.execute(sql, p);
    return (result as mysql.ResultSetHeader).affectedRows;
  } finally {
    await conn.end();
  }
});
