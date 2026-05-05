import {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  nativeTheme,
  Notification,
  session,
  shell,
} from "electron";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import initSqlJs, { type Database as SqlJsDb, type SqlValue } from "sql.js";
import { closeAllTunnels } from "./ssh-tunnel";
import { killAllSshShells } from "./ssh-shell";
import { killAllK8sExecs } from "./k8s-exec";
import { killAllK9sSessions } from "./k9s";
import { MIGRATIONS } from "../src/db/schema";
import { setDbGetter } from "./main-utils";

// Side-effect imports: register all IPC handlers for their domain
import "./plugin-host";
import "./ssh-host";
import "./k8s-host";
import "./cloud-auth";
import "./cloud-data";
import "./cloud-sync";
import "./cloud-ssh-keys";
import { teardownAllPfCloudSessions } from "./k8s-pf-cloud";

// Disable Chromium's built-in overscroll history navigation — we handle
// swipe-to-navigate ourselves in the renderer via wheel events.
app.commandLine.appendSwitch("overscroll-history-navigation", "0");

// Number of active metric pings — set by the renderer via `set_pings_active`.
// While > 0, closing the last window hides it instead of quitting so that the
// renderer's polling loop keeps firing notifications in the background.
let activePingCount = 0;
// True once the user has chosen Quit from the menu (or before-quit fired) —
// after this we let window close events through.
let quitting = false;

function startAutoUpdater() {
  if (!app.isPackaged) return;
  void import("electron-updater").then(({ autoUpdater }) => {
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.on("error", (err) => {
      console.warn("[updater]", err);
    });
    void autoUpdater.checkForUpdatesAndNotify();
    setInterval(
      () => {
        void autoUpdater.checkForUpdates();
      },
      4 * 60 * 60 * 1000,
    );
  });
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    titleBarStyle: "hiddenInset",
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#030712" : "#ffffff",
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.on("close", (event) => {
    if (quitting) return;
    if (activePingCount > 0) {
      event.preventDefault();
      win.hide();
    }
  });

  if (process.env["ELECTRON_RENDERER_URL"]) {
    win.loadURL(process.env["ELECTRON_RENDERER_URL"]);
    win.webContents.openDevTools();
  } else {
    win.loadFile(path.join(__dirname, "../renderer/index.html"));
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
  startAutoUpdater();
  app.on("activate", () => {
    const wins = BrowserWindow.getAllWindows();
    if (wins.length === 0) {
      createWindow();
      return;
    }
    // When pings are active we hide rather than close — show + focus existing windows.
    for (const w of wins) {
      if (!w.isVisible()) w.show();
      w.focus();
    }
  });
});

app.on("window-all-closed", () => {
  // If pings are active, stay running in the background so notifications still fire.
  // Otherwise fully quit — including on macOS, where the default is to stay in the dock.
  if (activePingCount > 0) return;
  app.quit();
});

app.on("before-quit", () => {
  quitting = true;
  closeAllTunnels();
  killAllSshShells();
  killAllK8sExecs();
  killAllK9sSessions();
  teardownAllPfCloudSessions();
});

ipcMain.handle("set_pings_active", (_e, { count }: { count: number }) => {
  activePingCount = Math.max(0, Math.floor(count));
});

ipcMain.handle("show_notification", (_e, { title, body }: { title: string; body: string }) => {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title, body });
  n.on("click", () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win) {
      if (!win.isVisible()) win.show();
      win.focus();
    }
  });
  n.show();
});

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

ipcMain.handle("get_or_create_encryption_key", () => getEncryptionKey().toString("base64"));

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
    // Split multi-statement migrations and run each individually,
    // ignoring "duplicate column" errors from re-running ALTER TABLE
    const statements = migration
      .split(";")
      .map((s) => s.trim())
      .filter(Boolean);
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

// Wire up the DB getter so cloud-auth / cloud-sync can access SQLite
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
  stmt.bind((params ?? []) as SqlValue[]);
  while (stmt.step()) rows.push(stmt.getAsObject() as Record<string, unknown>);
  stmt.free();
  return rows;
});

ipcMain.handle("db_execute", async (_e, { sql, params }: { sql: string; params?: unknown[] }) => {
  const db = await getSqlite();
  db.run(normalizeSql(sql), (params ?? []) as SqlValue[]);
  const rowsAffected = db.getRowsModified();
  persist();
  return { rowsAffected, lastInsertId: 0 };
});

ipcMain.handle("show_open_dialog", async (_e, options: Electron.OpenDialogOptions) => {
  const win = BrowserWindow.getFocusedWindow();
  return win ? dialog.showOpenDialog(win, options) : dialog.showOpenDialog(options);
});

ipcMain.handle("open_external_url", async (_e, { url }: { url: string }) => {
  await shell.openExternal(url);
});
