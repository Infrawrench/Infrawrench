import { app, BrowserWindow, ipcMain, dialog } from "electron";
import crypto from "node:crypto";
import fs from "node:fs";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import initSqlJs, { type Database as SqlJsDb } from "sql.js";
import { sqlDrivers, kvDrivers, dockerDrivers } from "./drivers";
import { openTunnel, closeTunnel, closeAllTunnels, getActiveTunnels, type SshTunnelConfig } from "./ssh-tunnel";
import { spawnSshShell, writeSshShell, resizeSshShell, killSshShell, killAllSshShells, type SshShellConfig } from "./ssh-shell";
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

app.on("before-quit", () => { closeAllTunnels(); killAllSshShells(); });

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

// ── Local SQLite (sql.js — pure WASM, no native compilation) ─────────────────

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

// ── Plugin SQL drivers ────────────────────────────────────────────────────────

ipcMain.handle("plugin_sql_query", async (_e, {
  driverId, connectionString, sql,
}: { driverId: string; connectionString: string; sql: string }) => {
  const driver = sqlDrivers.get(driverId);
  if (!driver) throw new Error(`No SQL driver registered for "${driverId}"`);
  return driver.query(connectionString, sql);
});

ipcMain.handle("plugin_sql_execute", async (_e, {
  driverId, connectionString, sql, params,
}: { driverId: string; connectionString: string; sql: string; params?: unknown[] }) => {
  const driver = sqlDrivers.get(driverId);
  if (!driver) throw new Error(`No SQL driver registered for "${driverId}"`);
  return driver.execute(connectionString, sql, params ?? []);
});

// ── Plugin KV drivers ─────────────────────────────────────────────────────────

ipcMain.handle("plugin_kv_command", async (_e, {
  driverId, connectionString, command, args,
}: { driverId: string; connectionString: string; command: string; args?: (string | number)[] }) => {
  const driver = kvDrivers.get(driverId);
  if (!driver) throw new Error(`No KV driver registered for "${driverId}"`);
  return driver.command(connectionString, command, args ?? []);
});

// ── Plugin Docker drivers ─────────────────────────────────────────────────────

ipcMain.handle("plugin_docker_command", async (_e, {
  driverId, dockerHost, op, params,
}: { driverId: string; dockerHost: string; op: string; params?: Record<string, unknown> }) => {
  const driver = dockerDrivers.get(driverId);
  if (!driver) throw new Error(`No Docker driver registered for "${driverId}"`);
  return driver.command(dockerHost, op, params ?? {});
});

// ── SSH tunnels ───────────────────────────────────────────────────────────────

ipcMain.handle("ssh_open_tunnel", (_e, config: SshTunnelConfig) =>
  openTunnel(config),
);

ipcMain.handle("ssh_close_tunnel", (_e, { tunnelId }: { tunnelId: string }) => {
  closeTunnel(tunnelId);
  return { ok: true };
});

ipcMain.handle("ssh_get_active_tunnels", () => getActiveTunnels());

// ── Native dialogs ────────────────────────────────────────────────────────────

ipcMain.handle("show_open_dialog", async (_e, options: Electron.OpenDialogOptions) => {
  const win = BrowserWindow.getFocusedWindow();
  return win
    ? dialog.showOpenDialog(win, options)
    : dialog.showOpenDialog(options);
});

// ── SSH system key discovery ──────────────────────────────────────────────────

ipcMain.handle("ssh_list_system_keys", () => {
  const sshDir = path.join(os.homedir(), ".ssh");
  if (!fs.existsSync(sshDir)) return [];
  const PRIVATE_KEY_HEADERS = [
    "-----BEGIN OPENSSH PRIVATE KEY-----",
    "-----BEGIN RSA PRIVATE KEY-----",
    "-----BEGIN EC PRIVATE KEY-----",
    "-----BEGIN DSA PRIVATE KEY-----",
  ];
  const results: { name: string }[] = [];
  for (const filename of fs.readdirSync(sshDir)) {
    if (filename.endsWith(".pub") || filename === "known_hosts" || filename === "authorized_keys" || filename === "config") continue;
    try {
      const filePath = path.join(sshDir, filename);
      const stat = fs.statSync(filePath);
      if (!stat.isFile()) continue;
      const first = fs.readFileSync(filePath, "utf8").slice(0, 100);
      if (PRIVATE_KEY_HEADERS.some((h) => first.includes(h))) {
        results.push({ name: filename });
      }
    } catch { /* skip unreadable files */ }
  }
  return results;
});

ipcMain.handle("ssh_read_system_key", (_e, { name }: { name: string }) => {
  const keyPath = path.join(os.homedir(), ".ssh", path.basename(name));
  return fs.readFileSync(keyPath, "utf8");
});

// ── SSH shell sessions ────────────────────────────────────────────────────────

ipcMain.handle("ssh_shell_spawn", (event, config: SshShellConfig) =>
  spawnSshShell(event.sender, config),
);

ipcMain.handle("ssh_shell_write", (_e, { shellId, data }: { shellId: string; data: string }) => {
  writeSshShell(shellId, data);
});

ipcMain.handle("ssh_shell_resize", (_e, { shellId, cols, rows }: { shellId: string; cols: number; rows: number }) => {
  resizeSshShell(shellId, cols, rows);
});

ipcMain.handle("ssh_shell_kill", (_e, { shellId }: { shellId: string }) => {
  killSshShell(shellId);
});

// ── GCS batch download ────────────────────────────────────────────────────────

function gcsDownloadFile(url: string, accessToken: string, destPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { Authorization: `Bearer ${accessToken}` } }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode ?? "?"}`));
        return;
      }
      fs.mkdirSync(path.dirname(destPath), { recursive: true });
      const out = fs.createWriteStream(destPath);
      res.pipe(out);
      out.on("finish", () => { out.close(); resolve(); });
      out.on("error", (e) => { fs.unlink(destPath, () => {}); reject(e); });
    });
    req.on("error", reject);
  });
}

ipcMain.handle("gcs_download_batch", async (
  event,
  { bucket, keys, destFolder, accessToken }: {
    bucket: string;
    keys: string[];
    destFolder: string;
    accessToken: string;
  },
) => {
  const errors: string[] = [];
  let done = 0;

  for (const key of keys) {
    const url = `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(key)}?alt=media`;
    const destPath = path.join(destFolder, ...key.split("/"));
    try {
      await gcsDownloadFile(url, accessToken, destPath);
    } catch (e) {
      errors.push(`${key}: ${String(e)}`);
    }
    done++;
    event.sender.send("gcs_download_progress", { done, total: keys.length });
  }

  return { errors };
});
