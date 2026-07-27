import {
  app,
  BrowserWindow,
  clipboard,
  ipcMain,
  dialog,
  nativeTheme,
  Notification,
  session,
  shell,
} from "electron";
import path from "node:path";
import crypto from "node:crypto";
import { generateEd25519OpenSshKeyPair } from "@infrawrench/ssh-tunnel-core";
import { z } from "zod";
import { type SqlValue } from "sql.js";
import { getSqlite, persist, normalizeSql, wireDbGetter } from "./db";
import { closeAllTunnels } from "./ssh-tunnel";
import { killAllSshShells } from "./ssh-shell";
import { killAllK8sExecs } from "./k8s-exec";
import { killAllK9sSessions } from "./k9s";
import { validateSql, validateParams, classifyMutation } from "./db-guard";
import { registerKubeconfigClusterEndpoints } from "./k8s-endpoints";
import { getShellCommandStatus, installShellCommand, uninstallShellCommand } from "./shell-command";
import {
  getEncryptionKey,
  encryptValue,
  decryptValue,
  buildAad,
  registerDialogBlessedPath,
} from "./main-utils";

// ssh2 has a teardown race when compression is negotiated: a channel's
// final ticks can try to compress a close packet through already-destroyed
// zlib writers, throwing inside ssh2's own tick callbacks where no caller
// try/catch can reach. We defer connection teardown to avoid it (see
// ssh-shell.ts), but swallow the specific error as a last resort — it is
// strictly a post-session cleanup artifact and never affects live traffic.
process.on("uncaughtException", (err) => {
  if (err instanceof Error && err.message === "Invalid Zlib instance") {
    console.warn("[ssh] ignored ssh2 compression teardown race:", err.stack?.split("\n")[1]);
    return;
  }
  // Registering any listener suppresses Electron's default crash dialog —
  // reproduce it for every other error so real crashes stay loud.
  console.error("Uncaught exception:", err);
  dialog.showErrorBox(
    "Uncaught Exception",
    err instanceof Error ? (err.stack ?? err.message) : String(err),
  );
  process.exit(1);
});

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
      // Resolve from the app root, not __dirname: main.ts is code-split into
      // out/main/chunks/ (the CLI bootstrap dynamically imports it), so
      // __dirname-relative paths would point inside out/main/.
      preload: path.join(app.getAppPath(), "out/preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // The renderer only ever shows our own bundle. Anything trying to navigate
  // it elsewhere — an injected link, a redirect from an embedded response, a
  // window.open — is either a bug or an attempt to load untrusted content into
  // a window that holds the user's cloud session and preload bridge. Send
  // external URLs to the system browser and refuse in-window navigation.
  const isInternalUrl = (url: string): boolean => {
    const rendererUrl = process.env["ELECTRON_RENDERER_URL"];
    if (rendererUrl && url.startsWith(rendererUrl)) return true;
    return url.startsWith("file://");
  };

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:$/.test(new URL(url).protocol)) void shell.openExternal(url);
    return { action: "deny" };
  });

  win.webContents.on("will-navigate", (event, url) => {
    if (isInternalUrl(url)) return;
    event.preventDefault();
    if (/^https?:$/.test(new URL(url).protocol)) void shell.openExternal(url);
  });

  // A renderer compromise shouldn't be able to attach a WebView with its own
  // (weaker) webPreferences.
  win.webContents.on("will-attach-webview", (event) => {
    event.preventDefault();
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
    win.loadFile(path.join(app.getAppPath(), "out/renderer/index.html"));
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

wireDbGetter();

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

// `infrawrench` shell command (CLI shim) management — see shell-command.ts.
ipcMain.handle("cli_shell_command_status", () => getShellCommandStatus());
ipcMain.handle("cli_install_shell_command", () => installShellCommand());
ipcMain.handle("cli_uninstall_shell_command", () => uninstallShellCommand());

// Native clipboard image read. The renderer cannot use
// navigator.clipboard.read() — Electron fails its permission check and the
// promise rejects — so terminal image paste goes through the main process.
ipcMain.handle("clipboard_read_image", () => {
  const image = clipboard.readImage();
  if (image.isEmpty()) return null;
  return { pngBase64: image.toPNG().toString("base64"), mime: "image/png" };
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
