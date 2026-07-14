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
import crypto from "node:crypto";
import { generateEd25519OpenSshKeyPair } from "@infrawrench/ssh-tunnel-core";
import { z } from "zod";
import initSqlJs, { type Database as SqlJsDb, type SqlValue } from "sql.js";
import { closeAllTunnels } from "./ssh-tunnel";
import { killAllSshShells } from "./ssh-shell";
import { killAllK8sExecs } from "./k8s-exec";
import { killAllK9sSessions } from "./k9s";
import { MIGRATIONS } from "../src/db/schema";
import { validateSql, validateParams, classifyMutation } from "./db-guard";
import { registerKubeconfigClusterEndpoints } from "./k8s-endpoints";
import {
  getEncryptionKey,
  encryptValue,
  decryptValue,
  buildAad,
  setDbGetter,
  registerDialogBlessedPath,
} from "./main-utils";

// Side-effect imports register IPC handlers for each domain.
import "./plugin-host";
import "./ssh-host";
import "./ssh-host-key-prompt";
import "./k8s-host";
import "./cloud-auth";
import "./cloud-data";
import "./cloud-sync";
import "./cloud-ssh-keys";
import "./workflow-host";
import { teardownAllPfCloudSessions } from "./k8s-pf-cloud";
import { reportTelemetry } from "./telemetry";

// Disable Chromium's built-in overscroll history navigation — we handle
// swipe-to-navigate ourselves in the renderer via wheel events.
app.commandLine.appendSwitch("overscroll-history-navigation", "0");

// While > 0, closing the last window hides it instead of quitting so the
// renderer's polling loop keeps firing notifications in the background.
let activePingCount = 0;
let activeCronCount = 0;
let quitting = false;

/** Whether background work (metric pings or enabled crons) should keep the app alive. */
function hasBackgroundWork(): boolean {
  return activePingCount > 0 || activeCronCount > 0;
}
// Set once electron-updater has staged a downloaded update; `before-quit`
// then calls `quitAndInstall` so the update actually applies on exit.
// MacUpdater (unlike BaseUpdater on win/linux) does not register a quit hook
// itself, so `autoInstallOnAppQuit` is effectively a no-op on macOS without this.
let pendingUpdateInstall: (() => void) | null = null;
let installingUpdate = false;
const AGENT_SSH_KEY_NAME = "infrawrench-agent";

function startAutoUpdater() {
  if (!app.isPackaged) return;
  // electron-updater exposes `autoUpdater` via a getter on its CJS exports,
  // which Node's dynamic-import named-export detection misses. Pull it off
  // `default` (= module.exports) where the getter actually lives.
  void import("electron-updater").then((mod) => {
    const { autoUpdater } = mod.default ?? mod;
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.on("error", (err) => {
      console.warn("[updater]", err);
    });
    autoUpdater.on("update-downloaded", (info) => {
      pendingUpdateInstall = () => {
        installingUpdate = true;
        autoUpdater.quitAndInstall();
      };
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.webContents.isDestroyed()) {
          win.webContents.send("update_available_prompt", { version: info.version });
        }
      }
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
    if (hasBackgroundWork()) {
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
  // Allow cross-origin DELETE/PUT/PATCH from the renderer to external APIs
  // (GCP, DO, etc.). Only inject headers when the server hasn't already sent
  // them — adding a second Access-Control-Allow-Origin breaks CORS entirely.
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const headers = { ...details.responseHeaders };
    const hasACAO = Object.keys(headers).some(
      (k) => k.toLowerCase() === "access-control-allow-origin",
    );

    // Always relax the allowed request-header list. Some providers (e.g.
    // Cloudflare) DO return their own CORS headers, but with an allow-list that
    // omits the headers their SDK injects — Cloudflare's `api-version` and the
    // Stainless `x-stainless-*` telemetry headers — so the browser blocks the
    // preflight even though ACAO is present. Replace any upstream value (delete
    // case-insensitively first to avoid emitting a duplicate header).
    //
    // AWS SigV4 requests carry x-amz-* headers (content-sha256, date, target,
    // security-token, user-agent) and Authorization; AWS returns no CORS
    // headers at all, so these double as the synthesized set for that case.
    for (const k of Object.keys(headers)) {
      if (k.toLowerCase() === "access-control-allow-headers") delete headers[k];
    }
    headers["Access-Control-Allow-Headers"] = [
      "Authorization, Content-Type, Accept, Api-Version, cf-aig-gateway-id, cf-aig-authorization, X-Amz-Content-Sha256, X-Amz-Date, X-Amz-Target, X-Amz-Security-Token, X-Amz-User-Agent, X-Amz-Algorithm, X-Amz-Credential, X-Amz-Signature, X-Amz-SignedHeaders, X-Auth-Token, X-Ovh-Application, X-Ovh-Timestamp, X-Ovh-Consumer, X-Ovh-Signature, X-ClickHouse-User, X-ClickHouse-Key, X-ClickHouse-Database, X-ClickHouse-Format, X-Stainless-Arch, X-Stainless-Lang, X-Stainless-Os, X-Stainless-Package-Version, X-Stainless-Retry-Count, X-Stainless-Runtime, X-Stainless-Runtime-Version, X-Stainless-Timeout",
    ];

    if (!hasACAO) {
      headers["Access-Control-Allow-Origin"] = ["*"];
      headers["Access-Control-Allow-Methods"] = ["DELETE, GET, HEAD, OPTIONS, POST, PUT, PATCH"];
      // OPTIONS preflight must return 200 OK — GCP compute and similar reject
      // cross-origin requests with 403, which the browser refuses even when
      // CORS headers are present.
      if (details.method === "OPTIONS") {
        callback({ responseHeaders: headers, statusLine: "HTTP/1.1 200 OK" });
        return;
      }
    }
    callback({ responseHeaders: headers });
  });

  createWindow();
  startAutoUpdater();
  reportTelemetry();
  app.on("activate", () => {
    const wins = BrowserWindow.getAllWindows();
    if (wins.length === 0) {
      createWindow();
      return;
    }
    for (const w of wins) {
      if (!w.isVisible()) w.show();
      w.focus();
    }
  });
});

app.on("window-all-closed", () => {
  // Stay alive while there's background work (active pings or enabled crons) so
  // notifications + scheduled workflows keep firing with the window closed.
  if (hasBackgroundWork()) return;
  app.quit();
});

app.on("before-quit", (event) => {
  // If an update is staged and the user picked "Later", apply it on quit.
  // `installingUpdate` is set inside the install callback so the second
  // before-quit (fired by electron-updater's own quit) falls through cleanly.
  if (pendingUpdateInstall && !installingUpdate) {
    event.preventDefault();
    const install = pendingUpdateInstall;
    pendingUpdateInstall = null;
    install();
    return;
  }
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

ipcMain.handle("set_crons_active", (_e, { count }: { count: number }) => {
  activeCronCount = Math.max(0, Math.floor(count));
});

ipcMain.handle("update_install_now", () => {
  if (pendingUpdateInstall) {
    const install = pendingUpdateInstall;
    pendingUpdateInstall = null;
    install();
  }
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

// Narrow typed channels below each bind their plaintext to a specific
// row + field via AAD, so a ciphertext from one row cannot be swapped into
// another. The renderer never sees the raw master key.

const MAX_PLAINTEXT_BYTES = 64 * 1024; // fits PEM keys + credential JSON
const MAX_CIPHERTEXT_BYTES = 96 * 1024;

const AccountIdArgs = z.object({ accountId: z.string().min(1).max(128) });
const AccountSaveArgs = z.object({
  accountId: z.string().min(1).max(128),
  credentials: z.record(z.string(), z.string().max(MAX_PLAINTEXT_BYTES)),
});
const AccountCreateArgs = z.object({
  accountId: z.string().min(1).max(128),
  pluginId: z.string().min(1).max(128),
  displayName: z.string().min(1).max(256),
  credentials: z.record(z.string(), z.string().max(MAX_PLAINTEXT_BYTES)),
});
const SshKeyIdArgs = z.object({ keyId: z.string().min(1).max(128) });
const SshKeyCreateArgs = z.object({
  keyId: z.string().min(1).max(128),
  name: z.string().min(1).max(256),
  privateKey: z.string().min(1).max(MAX_PLAINTEXT_BYTES),
});
const SshTunnelConfigDecryptArgs = z.object({
  tunnelConfigId: z.string().min(1).max(128),
  ciphertext: z.string().max(MAX_CIPHERTEXT_BYTES),
  iv: z.string().max(64),
});
const SshTunnelConfigEncryptArgs = z.object({
  tunnelConfigId: z.string().min(1).max(128),
  privateKey: z.string().min(1).max(MAX_PLAINTEXT_BYTES),
});
const SecretFieldDecryptArgs = z.object({
  resourceId: z.string().min(1).max(256),
  fieldKey: z.string().min(1).max(128),
  ciphertext: z.string().max(MAX_CIPHERTEXT_BYTES),
  iv: z.string().max(64),
});
const SecretFieldEncryptArgs = z.object({
  resourceId: z.string().min(1).max(256),
  fieldKey: z.string().min(1).max(128),
  plaintext: z.string().max(MAX_PLAINTEXT_BYTES),
});

ipcMain.handle("account_get_credentials", async (_e, raw: unknown) => {
  const { accountId } = AccountIdArgs.parse(raw);
  const db = await getSqlite();
  const stmt = db.prepare(
    "SELECT encrypted_credentials, credentials_iv FROM accounts WHERE id = ? LIMIT 1",
  );
  stmt.bind([accountId]);
  const row = stmt.step() ? (stmt.getAsObject() as Record<string, unknown>) : null;
  stmt.free();
  if (!row) throw new Error("Account not found");
  const ciphertext = String(row["encrypted_credentials"] ?? "");
  const iv = String(row["credentials_iv"] ?? "");
  const aad = buildAad("account", accountId, "credentials");
  const plaintext = decryptValue(ciphertext, iv, getEncryptionKey(), aad);
  const credentials = JSON.parse(plaintext) as Record<string, string>;
  // The renderer always loads an account's credentials through here before
  // talking to its cluster, so decrypt-time registration keeps the SSRF
  // allowlist populated across app restarts.
  await registerKubeconfigClusterEndpoints(credentials["kubeconfig"]);
  return credentials;
});

ipcMain.handle("account_save_credentials", async (_e, raw: unknown) => {
  const { accountId, credentials } = AccountSaveArgs.parse(raw);
  const plaintext = JSON.stringify(credentials);
  if (plaintext.length > MAX_PLAINTEXT_BYTES) {
    throw new Error("account_save_credentials: credentials too large");
  }
  const aad = buildAad("account", accountId, "credentials");
  const { ciphertext, iv } = encryptValue(plaintext, getEncryptionKey(), aad);
  const db = await getSqlite();
  db.run("UPDATE accounts SET encrypted_credentials = ?, credentials_iv = ? WHERE id = ?", [
    ciphertext,
    iv,
    accountId,
  ]);
  if (db.getRowsModified() === 0) {
    throw new Error("Account not found");
  }
  persist();
  await registerKubeconfigClusterEndpoints(credentials["kubeconfig"]);
});

ipcMain.handle("account_create", async (_e, raw: unknown) => {
  const { accountId, pluginId, displayName, credentials } = AccountCreateArgs.parse(raw);
  const plaintext = JSON.stringify(credentials);
  if (plaintext.length > MAX_PLAINTEXT_BYTES) {
    throw new Error("account_create: credentials too large");
  }
  const aad = buildAad("account", accountId, "credentials");
  const { ciphertext, iv } = encryptValue(plaintext, getEncryptionKey(), aad);
  const db = await getSqlite();
  db.run(
    `INSERT INTO accounts (id, plugin_id, display_name, encrypted_credentials, credentials_iv)
     VALUES (?, ?, ?, ?, ?)`,
    [accountId, pluginId, displayName, ciphertext, iv],
  );
  persist();
  await registerKubeconfigClusterEndpoints(credentials["kubeconfig"]);
});

ipcMain.handle("ssh_key_get_private_key", async (_e, raw: unknown) => {
  const { keyId } = SshKeyIdArgs.parse(raw);
  const db = await getSqlite();
  const stmt = db.prepare("SELECT encrypted_key, key_iv FROM ssh_keys WHERE id = ? LIMIT 1");
  stmt.bind([keyId]);
  const row = stmt.step() ? (stmt.getAsObject() as Record<string, unknown>) : null;
  stmt.free();
  if (!row) throw new Error("SSH key not found");
  const ciphertext = String(row["encrypted_key"] ?? "");
  const iv = String(row["key_iv"] ?? "");
  const aad = buildAad("sshKey", keyId, "privateKey");
  return decryptValue(ciphertext, iv, getEncryptionKey(), aad);
});

ipcMain.handle("ssh_key_get_public_key", async (_e, raw: unknown) => {
  const { keyId } = SshKeyIdArgs.parse(raw);
  const db = await getSqlite();
  const stmt = db.prepare("SELECT encrypted_key, key_iv FROM ssh_keys WHERE id = ? LIMIT 1");
  stmt.bind([keyId]);
  const row = stmt.step() ? (stmt.getAsObject() as Record<string, unknown>) : null;
  stmt.free();
  if (!row) throw new Error("SSH key not found");
  const privateKey = decryptValue(
    String(row["encrypted_key"] ?? ""),
    String(row["key_iv"] ?? ""),
    getEncryptionKey(),
    buildAad("sshKey", keyId, "privateKey"),
  );
  // Desktop app keys persist only the private half — derive the OpenSSH public
  // key from it on demand.
  const parsed = (await getSsh2Utils()).parseKey(privateKey);
  if (parsed instanceof Error) {
    throw new Error(`Could not derive public key for SSH key: ${parsed.message}`);
  }
  const key = Array.isArray(parsed) ? parsed[0] : parsed;
  return `${key.type} ${key.getPublicSSH().toString("base64")}`;
});

ipcMain.handle("ssh_key_ensure_agent_key", async () => {
  const db = await getSqlite();
  const existing = db.prepare("SELECT id FROM ssh_keys WHERE name = ? LIMIT 1");
  existing.bind([AGENT_SSH_KEY_NAME]);
  const row = existing.step() ? (existing.getAsObject() as Record<string, unknown>) : null;
  existing.free();
  if (row) {
    const keyId = String(row["id"] ?? "");
    const stmt = db.prepare("SELECT encrypted_key, key_iv FROM ssh_keys WHERE id = ? LIMIT 1");
    stmt.bind([keyId]);
    const keyRow = stmt.step() ? (stmt.getAsObject() as Record<string, unknown>) : null;
    stmt.free();
    if (!keyRow) throw new Error("Agent SSH key not found");
    const privateKey = decryptValue(
      String(keyRow["encrypted_key"] ?? ""),
      String(keyRow["key_iv"] ?? ""),
      getEncryptionKey(),
      buildAad("sshKey", keyId, "privateKey"),
    );
    return {
      id: keyId,
      name: AGENT_SSH_KEY_NAME,
      publicKey: await deriveOpenSshPublicKey(privateKey),
    };
  }

  const { publicKey, privateKey } = await generateEd25519OpenSshKeyPair(AGENT_SSH_KEY_NAME);
  const keyId = crypto.randomUUID();
  const aad = buildAad("sshKey", keyId, "privateKey");
  const { ciphertext, iv } = encryptValue(privateKey, getEncryptionKey(), aad);
  db.run("INSERT INTO ssh_keys (id, name, encrypted_key, key_iv) VALUES (?, ?, ?, ?)", [
    keyId,
    AGENT_SSH_KEY_NAME,
    ciphertext,
    iv,
  ]);
  persist();
  return { id: keyId, name: AGENT_SSH_KEY_NAME, publicKey };
});

ipcMain.handle("ssh_key_save_private_key", async (_e, raw: unknown) => {
  const { keyId, name, privateKey } = SshKeyCreateArgs.parse(raw);
  const aad = buildAad("sshKey", keyId, "privateKey");
  const { ciphertext, iv } = encryptValue(privateKey, getEncryptionKey(), aad);
  const db = await getSqlite();
  db.run("INSERT INTO ssh_keys (id, name, encrypted_key, key_iv) VALUES (?, ?, ?, ?)", [
    keyId,
    name,
    ciphertext,
    iv,
  ]);
  persist();
});

async function deriveOpenSshPublicKey(privateKey: string): Promise<string> {
  const parsed = (await getSsh2Utils()).parseKey(privateKey);
  if (parsed instanceof Error) {
    throw new Error(`Could not derive public key for SSH key: ${parsed.message}`);
  }
  const key = Array.isArray(parsed) ? parsed[0] : parsed;
  return `${key.type} ${key.getPublicSSH().toString("base64")} ${AGENT_SSH_KEY_NAME}`;
}

async function getSsh2Utils(): Promise<typeof import("ssh2").utils> {
  const mod = await import("ssh2");
  const utils = mod.utils ?? mod.default?.utils;
  if (!utils) throw new Error("Could not load ssh2 key utilities");
  return utils;
}

ipcMain.handle("ssh_tunnel_config_get_private_key", (_e, raw: unknown) => {
  const { tunnelConfigId, ciphertext, iv } = SshTunnelConfigDecryptArgs.parse(raw);
  const aad = buildAad("sshTunnelConfig", tunnelConfigId, "privateKey");
  return decryptValue(ciphertext, iv, getEncryptionKey(), aad);
});

ipcMain.handle("ssh_tunnel_config_encrypt_private_key", (_e, raw: unknown) => {
  const { tunnelConfigId, privateKey } = SshTunnelConfigEncryptArgs.parse(raw);
  const aad = buildAad("sshTunnelConfig", tunnelConfigId, "privateKey");
  return encryptValue(privateKey, getEncryptionKey(), aad);
});

// Oracle-shaped (renderer supplies ciphertext/iv on decrypt) but the AAD binds
// each call to a specific (resourceId, fieldKey), so an attacker cannot swap
// ciphertexts across fields or rows.
ipcMain.handle("secret_field_decrypt", (_e, raw: unknown) => {
  const { resourceId, fieldKey, ciphertext, iv } = SecretFieldDecryptArgs.parse(raw);
  const aad = buildAad("secretField", `${resourceId}:${fieldKey}`, "value");
  return decryptValue(ciphertext, iv, getEncryptionKey(), aad);
});

ipcMain.handle("secret_field_encrypt", (_e, raw: unknown) => {
  const { resourceId, fieldKey, plaintext } = SecretFieldEncryptArgs.parse(raw);
  const aad = buildAad("secretField", `${resourceId}:${fieldKey}`, "value");
  return encryptValue(plaintext, getEncryptionKey(), aad);
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

// db_select / db_execute expose the local sql.js DB to the renderer. Access is
// gated by the typed preload bridge plus db-guard's validateSql/validateParams
// (no multi-statements, no ATTACH/DETACH/PRAGMA/VACUUM/LOAD_EXTENSION, capped
// sizes, primitive params only). A compromised renderer can still mutate any
// user-owned table — the surface is narrowed, not eliminated.
ipcMain.handle("db_select", async (_e, { sql, params }: { sql: string; params?: unknown[] }) => {
  validateSql(sql);
  const safeParams = validateParams(params);
  const db = await getSqlite();
  const stmt = db.prepare(normalizeSql(sql));
  const rows: Record<string, unknown>[] = [];
  stmt.bind(safeParams as SqlValue[]);
  while (stmt.step()) rows.push(stmt.getAsObject() as Record<string, unknown>);
  stmt.free();
  return rows;
});

ipcMain.handle("db_execute", async (_e, { sql, params }: { sql: string; params?: unknown[] }) => {
  validateSql(sql);
  const safeParams = validateParams(params);
  const audit = classifyMutation(sql);
  if (audit) {
    const preview = sql.length > 200 ? `${sql.slice(0, 200)}…` : sql;
    console.log(
      `[db-audit] ${audit.op} on ${audit.table} (params=${safeParams.length}) :: ${preview}`,
    );
  }
  const db = await getSqlite();
  db.run(normalizeSql(sql), safeParams as SqlValue[]);
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
