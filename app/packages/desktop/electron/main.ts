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
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import initSqlJs, { type Database as SqlJsDb, type SqlValue } from "sql.js";
import { closeAllTunnels } from "./ssh-tunnel";
import { killAllSshShells } from "./ssh-shell";
import { killAllK8sExecs } from "./k8s-exec";
import { killAllK9sSessions } from "./k9s";
import { MIGRATIONS } from "../src/db/schema";
import {
  getEncryptionKey,
  encryptValue,
  decryptValue,
  setDbGetter,
  registerDialogBlessedPath,
} from "./main-utils";

// Side-effect imports: register all IPC handlers for their domain
import "./plugin-host";
import "./ssh-host";
import "./ssh-host-key-prompt";
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

// NOTE: master-key handling has been consolidated into ./main-utils.ts —
// it now wraps the on-disk key with Electron's safeStorage (OS keychain /
// DPAPI) and falls back to 0o600 plaintext only when the platform's keyring
// is unavailable.
//
// The `get_or_create_encryption_key` handler that previously returned the raw
// master key to the renderer has been removed entirely. The renderer no
// longer has any way to obtain the key — it must use `encrypt_value` /
// `decrypt_value` below, which run in the main process.
//
// `encrypt_value` and `decrypt_value` still expose an encryption oracle to
// the renderer, which we'd like to remove eventually. For now, every caller
// in the codebase uses them to read/write SSH private keys or
// service-credential JSON stored in the desktop sql.js DB — replacing them
// outright would require moving every credential-display flow into main.
// Inputs are size-bounded below to make the oracle less useful, but this is
// still an architectural weakness — see the FIX_FLAG comment.

// FIX_FLAG: encrypt_value / decrypt_value remain a per-blob encryption oracle
// for any renderer code (and therefore any XSS). Long-term, replace each
// caller with a typed main-process operation (e.g. `open_account_connection`)
// that performs the decrypt + use inside main.

const MAX_PLAINTEXT_BYTES = 64 * 1024; // 64 KiB — fits PEM keys + credential JSON
const MAX_CIPHERTEXT_BYTES = 96 * 1024;

const EncryptArgs = z.object({
  plaintext: z.string().max(MAX_PLAINTEXT_BYTES),
});

const DecryptArgs = z.object({
  ciphertext: z.string().max(MAX_CIPHERTEXT_BYTES),
  iv: z.string().max(64),
});

ipcMain.handle("encrypt_value", (_e, raw: unknown) => {
  const { plaintext } = EncryptArgs.parse(raw);
  return encryptValue(plaintext, getEncryptionKey());
});

ipcMain.handle("decrypt_value", (_e, raw: unknown) => {
  const { ciphertext, iv } = DecryptArgs.parse(raw);
  return decryptValue(ciphertext, iv, getEncryptionKey());
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

// FIX_FLAG: db_select / db_execute let the renderer run arbitrary SQL against
// the local sql.js DB. The bundled renderer JS is the only thing that should
// invoke them, and access is now gated through the typed preload bridge
// (electron/preload.ts) — there's no raw `invoke(channel, args)` path for an
// XSS payload to reach an unexpected channel. A future change should replace
// these with typed query helpers (per-table CRUD) so a renderer compromise
// can't pivot through arbitrary SQL.
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
  const result = win
    ? await dialog.showOpenDialog(win, options)
    : await dialog.showOpenDialog(options);
  if (!result.canceled) {
    for (const p of result.filePaths ?? []) registerDialogBlessedPath(p);
  }
  return result;
});

ipcMain.handle("show_save_dialog", async (_e, options: Electron.SaveDialogOptions) => {
  const win = BrowserWindow.getFocusedWindow();
  const result = win
    ? await dialog.showSaveDialog(win, options)
    : await dialog.showSaveDialog(options);
  if (!result.canceled && result.filePath) registerDialogBlessedPath(result.filePath);
  return result;
});

const EXTERNAL_URL_SCHEMES = new Set(["http:", "https:", "mailto:"]);

ipcMain.handle("open_external_url", async (_e, { url }: { url: string }) => {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("open_external_url: invalid URL");
  }
  if (!EXTERNAL_URL_SCHEMES.has(parsed.protocol)) {
    throw new Error(`open_external_url: scheme "${parsed.protocol}" is not permitted`);
  }
  await shell.openExternal(parsed.toString());
});
