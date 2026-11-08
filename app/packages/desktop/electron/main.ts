import {
  app,
  autoUpdater as nativeUpdater,
  BrowserWindow,
  dialog,
  nativeTheme,
  session,
  shell,
} from "electron";
import path from "node:path";
import { pathToFileURL } from "node:url";
import dns from "node:dns";
import { wireDbGetter } from "./db";
import { closeAllTunnels } from "./ssh-tunnel";
import { killAllSshShells } from "./ssh-shell";
import { killAllK8sExecs } from "./k8s-exec";
import { killAllK9sSessions } from "./k9s";
import { createHostResolver, shouldRelaxCors } from "./cors-policy";
import { isInternalRendererUrl } from "./renderer-navigation";
import { getActiveTunnels } from "./ssh-tunnel";
import { CLOUD_URL } from "../env";
import { startRpcServer } from "./rpc/server";
import { getPendingUpdateInstall, hasBackgroundWork, setPendingUpdateInstall } from "./app-shell";

// ssh2 has a teardown race when compression is negotiated: a channel's
// final ticks can try to compress a close packet through already-destroyed
// zlib writers, throwing inside ssh2's own tick callbacks where no caller
// try/catch can reach. We defer connection teardown to avoid it (see
// ssh-shell.ts), but swallow the specific error as a last resort: it is
// strictly a post-session cleanup artifact and never affects live traffic.
process.on("uncaughtException", (err) => {
  if (err instanceof Error && err.message === "Invalid Zlib instance") {
    console.warn("[ssh] ignored ssh2 compression teardown race:", err.stack?.split("\n")[1]);
    return;
  }
  // Registering any listener suppresses Electron's default crash dialog:
  // reproduce it for every other error so real crashes stay loud.
  console.error("Uncaught exception:", err);
  dialog.showErrorBox(
    "Uncaught Exception",
    err instanceof Error ? (err.stack ?? err.message) : String(err),
  );
  process.exit(1);
});

// Side-effect imports register IPC handlers for each domain.
import { shutdownIwappdSessions } from "./iwappd-host";
import "./cloud-auth";
import "./cloud-data";
import "./cloud-sync";
import "./provider-oauth/routes";
import { teardownAllPfCloudSessions } from "./k8s-pf-cloud";
import { reportTelemetry } from "./telemetry";

// Disable Chromium's built-in overscroll history navigation: we handle
// swipe-to-navigate ourselves in the renderer via wheel events.
app.commandLine.appendSwitch("overscroll-history-navigation", "0");

// Background work (metric pings, enabled crons) and the staged update's
// install callback live in `./app-shell`, which the renderer sets over RPC.
let quitting = false;
// The pending install (`setPendingUpdateInstall`) is called from
// `before-quit` so the update actually applies on exit. MacUpdater (unlike
// BaseUpdater on win/linux) does not register a quit hook itself, so
// `autoInstallOnAppQuit` is effectively a no-op on macOS without this.
let installingUpdate = false;

/** How long to wait for `quitAndInstall` to actually take the app down. */
const INSTALL_STALL_TIMEOUT_MS = 20_000;

function broadcastToWindows(channel: string, payload: unknown) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.webContents.isDestroyed()) win.webContents.send(channel, payload);
  }
}

/**
 * Updater failures are otherwise invisible: the renderer only ever sees a
 * prompt that never resolves. Translate the ones a user can act on.
 */
function describeUpdateError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  if (/ENOSPC|No space left|not enough (free )?space|insufficient disk/i.test(message)) {
    return "There isn't enough free disk space to unpack the update. Free up a few gigabytes and Infrawrench will retry on its next check.";
  }
  if (/ENOTFOUND|ETIMEDOUT|ECONNRESET|ECONNREFUSED|net::|socket hang up/i.test(message)) {
    return "Infrawrench couldn't reach the update server. It'll retry automatically.";
  }
  if (/signature|code sign|SQRLUpdater/i.test(message)) {
    return "The downloaded update failed its signature check and wasn't installed. Download the latest version from infrawrench.com.";
  }
  return message;
}

function startAutoUpdater() {
  if (!app.isPackaged) return;
  // electron-updater exposes `autoUpdater` via a getter on its CJS exports,
  // which Node's dynamic-import named-export detection misses. Pull it off
  // `default` (= module.exports) where the getter actually lives.
  void import("electron-updater").then((mod) => {
    const { autoUpdater } = mod.default ?? mod;
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;

    // macOS hands the install to Squirrel.Mac, which fetches the downloaded zip
    // back off electron-updater's own localhost proxy and stages it before
    // anything is installable. electron-updater fires `update-downloaded` when
    // *its* download lands (before Squirrel has even started) and until
    // staging finishes `quitAndInstall()` is a silent no-op that neither quits
    // nor errors. Prompting on that event hands the user a "Restart now" button
    // that does nothing, and if staging never succeeds (a full disk is enough)
    // it never will. Wait for the native updater's own `update-downloaded`,
    // which fires only once restarting is guaranteed to apply the update.
    const stagesNatively = process.platform === "darwin";
    let downloadedVersion: string | null = null;
    let promptedVersion: string | null = null;

    const promptForInstall = (version: string) => {
      if (promptedVersion === version) return;
      promptedVersion = version;
      setPendingUpdateInstall(() => {
        installingUpdate = true;
        autoUpdater.quitAndInstall();
        // If the app is still here well after quitAndInstall, the install did
        // not take. Hand the user back a working window and fall back to
        // installing on quit rather than leaving a dead "Restarting…" modal.
        const stall = setTimeout(() => {
          installingUpdate = false;
          broadcastToWindows("update_error", {
            version,
            message:
              "Infrawrench couldn't restart into the new version. It will be installed the next time you quit.",
          });
        }, INSTALL_STALL_TIMEOUT_MS);
        stall.unref();
      });
      broadcastToWindows("update_available_prompt", { version });
    };

    if (stagesNatively) {
      nativeUpdater.on("update-downloaded", () => {
        if (downloadedVersion) promptForInstall(downloadedVersion);
      });
    }

    autoUpdater.on("error", (err) => {
      console.warn("[updater]", err);
      // Check/download failures retry on their own and aren't worth a modal.
      // Once a version is downloaded, a failure means staging or installing
      // broke: the user is either waiting on a prompt that will never arrive
      // or staring at one that can't complete, so say what went wrong.
      if (!downloadedVersion) return;
      broadcastToWindows("update_error", {
        version: downloadedVersion,
        message: describeUpdateError(err),
      });
    });

    autoUpdater.on("update-downloaded", (info) => {
      downloadedVersion = info.version;
      if (!stagesNatively) promptForInstall(info.version);
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
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#2b2b2f" : "#e9e9eb",
    webPreferences: {
      // Resolve from the app root, not __dirname: main.ts is code-split into
      // out/main/chunks/ (the CLI bootstrap dynamically imports it), so
      // __dirname-relative paths would point inside out/main/.
      preload: path.join(app.getAppPath(), "out/preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      // Dropping a file onto the window must not navigate to it.
      navigateOnDragDrop: false,
    },
  });

  // The renderer only ever shows our own bundle. Anything trying to navigate
  // it elsewhere (an injected link, a redirect from an embedded response, a
  // window.open, a dropped file) is either a bug or an attempt to load
  // untrusted content into a window that holds the user's cloud session and
  // preload bridge. Send external URLs to the system browser and refuse
  // in-window navigation. See renderer-navigation.ts for why this is an exact
  // match rather than a `file://` prefix.
  const rendererLocation = {
    devServerUrl: process.env["ELECTRON_RENDERER_URL"],
    indexFileUrl: pathToFileURL(path.join(app.getAppPath(), "out/renderer/index.html")).href,
    caseInsensitivePaths: process.platform === "win32",
  };
  const isInternalUrl = (url: string): boolean => isInternalRendererUrl(url, rendererLocation);
  const openIfWeb = (url: string) => {
    try {
      if (/^https?:$/.test(new URL(url).protocol)) void shell.openExternal(url);
    } catch {
      // Not a URL: nothing to open.
    }
  };

  win.webContents.setWindowOpenHandler(({ url }) => {
    openIfWeb(url);
    return { action: "deny" };
  });

  win.webContents.on("will-navigate", (event, url) => {
    if (isInternalUrl(url)) return;
    event.preventDefault();
    openIfWeb(url);
  });

  // A server redirect is a navigation will-navigate never sees.
  win.webContents.on("will-redirect", (event, url) => {
    if (isInternalUrl(url)) return;
    event.preventDefault();
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

/** Add permissive CORS headers to a response `shouldRelaxCors` admitted. */
function relaxCorsHeaders(
  details: Electron.OnHeadersReceivedListenerDetails,
  callback: (response: Electron.HeadersReceivedResponse) => void,
) {
  const headers = { ...details.responseHeaders };
  const hasACAO = Object.keys(headers).some(
    (k) => k.toLowerCase() === "access-control-allow-origin",
  );

  // Always relax the allowed request-header list. Some providers (e.g.
  // Cloudflare) DO return their own CORS headers, but with an allow-list that
  // omits the headers their SDK injects (Cloudflare's `api-version` and the
  // Stainless `x-stainless-*` telemetry headers) so the browser blocks the
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
    // OPTIONS preflight must return 200 OK: GCP compute and similar reject
    // cross-origin requests with 403, which the browser refuses even when
    // CORS headers are present.
    if (details.method === "OPTIONS") {
      callback({ responseHeaders: headers, statusLine: "HTTP/1.1 200 OK" });
      return;
    }
  }
  callback({ responseHeaders: headers });
}

app.whenReady().then(() => {
  // Allow cross-origin DELETE/PUT/PATCH from the renderer to external APIs
  // (GCP, DO, etc.). Only inject headers when the server hasn't already sent
  // them: adding a second Access-Control-Allow-Origin breaks CORS entirely.
  // Never for this machine or the private network unless the user configured
  // that endpoint (cors-policy.ts): otherwise any renderer script could read
  // localhost and intranet services.
  const cloudOrigin = new URL(CLOUD_URL).origin;
  const resolveHost = createHostResolver(async (hostname) =>
    (await dns.promises.lookup(hostname, { all: true })).map((a) => a.address),
  );
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    let hostname: string;
    try {
      const url = new URL(details.url);
      if (url.protocol !== "https:" && url.protocol !== "http:") {
        callback({});
        return;
      }
      hostname = url.hostname;
    } catch {
      callback({});
      return;
    }
    void resolveHost(hostname).then(
      (addresses) => {
        const relax = shouldRelaxCors(
          { url: details.url, addresses },
          {
            cloudOrigin,
            tunnelPorts: Object.values(getActiveTunnels()).map((t) => t.localPort),
          },
        );
        if (relax) relaxCorsHeaders(details, callback);
        else callback({});
      },
      () => callback({}),
    );
  });

  // Note on microphone access for the Speech tab: no Electron permission
  // handler is registered on purpose. `media` requests already reach the OS
  // under Electron's default behaviour, and installing a handler here would
  // change the answer for every *other* permission at the same time: this
  // renderer already relies on that default (see the clipboard-read fallback
  // in SshTerminal.tsx). What macOS actually needs is declarative and lives
  // outside this file: NSMicrophoneUsageDescription in package.json's
  // `mac.extendInfo`, and com.apple.security.device.audio-input in
  // build/info.plist. Miss those and a packaged build is denied capture (or
  // killed outright) while `pnpm dev` keeps working, because the prebuilt
  // Electron.app ships its own microphone usage string.

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

app.on("before-quit", () => {
  // Every session holds an SSH connection and a compositor on someone else's
  // machine; quitting without closing them leaves both until the idle timeout.
  shutdownIwappdSessions();
});

app.on("before-quit", (event) => {
  // If an update is staged and the user picked "Later", apply it on quit.
  // `installingUpdate` is set inside the install callback so the second
  // before-quit (fired by electron-updater's own quit) falls through cleanly.
  const pendingUpdateInstall = getPendingUpdateInstall();
  if (pendingUpdateInstall && !installingUpdate) {
    event.preventDefault();
    pendingUpdateInstall();
    // Cancelling the quit is only safe because the updater is expected to
    // re-quit us. If it doesn't, quit for real rather than leaving an app that
    // can't be closed.
    const fallback = setTimeout(() => {
      setPendingUpdateInstall(null);
      app.quit();
    }, INSTALL_STALL_TIMEOUT_MS);
    fallback.unref();
    return;
  }
  quitting = true;
  closeAllTunnels();
  killAllSshShells();
  killAllK8sExecs();
  killAllK9sSessions();
  teardownAllPfCloudSessions();
});

wireDbGetter();

// Effect RPC (`shared/rpc/groups`): every renderer-to-main operation this file
// used to register one `ipcMain.handle` for (the app shell, local credentials
// and secrets, the renderer's SQLite access) is a group there, served by
// `rpc/server.ts`. Listening before any window loads, so a renderer's first
// connect is never missed.
startRpcServer();
