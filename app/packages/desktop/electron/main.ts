import { app, BrowserWindow, ipcMain, dialog, session, shell } from "electron";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import initSqlJs, { type Database as SqlJsDb } from "sql.js";
import { closeAllTunnels } from "./ssh-tunnel";
import { killAllSshShells } from "./ssh-shell";
import { killAllK8sExecs } from "./k8s-exec";
import { killAllK9sSessions } from "./k9s";
import { MIGRATIONS } from "../src/db/schema";

// Side-effect imports: register all IPC handlers for their domain
import "./plugin-host";
import "./ssh-host";
import "./k8s-host";

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
  // Allow the renderer to make cross-origin requests (including DELETE/PUT) to
  // external APIs such as GCP and DigitalOcean. Without this, the browser blocks
  // the CORS preflight for non-simple methods when the app loads from file://.
  // Allow the renderer to make cross-origin DELETE/PUT/PATCH requests to external
  // APIs (GCP, DO, etc.). Only inject headers when the server hasn't already sent
  // them — adding a second Access-Control-Allow-Origin value breaks CORS entirely.
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const headers = { ...details.responseHeaders };
    const hasACAO = Object.keys(headers).some(
      (k) => k.toLowerCase() === "access-control-allow-origin",
    );
    if (!hasACAO) {
      headers["Access-Control-Allow-Origin"] = ["*"];
      headers["Access-Control-Allow-Methods"] = ["DELETE, GET, HEAD, OPTIONS, POST, PUT, PATCH"];
      headers["Access-Control-Allow-Headers"] = ["Authorization, Content-Type, Accept"];
      // OPTIONS preflight must return 200 OK — servers that reject cross-origin
      // requests (e.g. GCP compute) return 403, which the browser refuses even
      // when CORS headers are present. Only override status when we're injecting.
      if (details.method === "OPTIONS") {
        callback({ responseHeaders: headers, statusLine: "HTTP/1.1 200 OK" });
        return;
      }
    }
    callback({ responseHeaders: headers });
  });

  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  closeAllTunnels();
  killAllSshShells();
  killAllK8sExecs();
  killAllK9sSessions();
});

// ── Encryption ────────────────────────────────────────────────────────────────

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

// ── Local SQLite ──────────────────────────────────────────────────────────────

let _sqlite: SqlJsDb | null = null;
let _sqlitePath: string;

async function getSqlite(): Promise<SqlJsDb> {
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
    _sqlite.run(migration);
  }
  persist();

  return _sqlite;
}

function persist() {
  if (!_sqlite) return;
  fs.writeFileSync(_sqlitePath, Buffer.from(_sqlite.export()));
}

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

// ── Native dialogs ────────────────────────────────────────────────────────────

ipcMain.handle("show_open_dialog", async (_e, options: Electron.OpenDialogOptions) => {
  const win = BrowserWindow.getFocusedWindow();
  return win
    ? dialog.showOpenDialog(win, options)
    : dialog.showOpenDialog(options);
});

ipcMain.handle("open_external_url", async (_e, { url }: { url: string }) => {
  await shell.openExternal(url);
});
