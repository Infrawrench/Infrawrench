// What `electron` is in the standalone CLI: the standalone build
// (`scripts/build-cli.mjs`) resolves every `import … from "electron"` here,
// so the modules the CLI shares with the desktop app (`db.ts`,
// `main-utils.ts`, `cloud-tokens.ts`, `cli/main.ts`, the login command) run
// on plain Node unchanged. It covers exactly the members those modules use;
// the build fails on a named import this file does not export, and
// `standalone-cli.test.ts` fails on a member it does not implement.
//
// No import-time side effects: like `db.ts` and `cloud-tokens.ts`, this is
// on every command line's path.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

declare const __INFRAWRENCH_CLI_VERSION__: string | undefined;

const VERSION =
  typeof __INFRAWRENCH_CLI_VERSION__ !== "undefined" ? __INFRAWRENCH_CLI_VERSION__ : "0.0.0";

/**
 * Where the standalone CLI keeps its session: `INFRAWRENCH_CONFIG_DIR`, else
 * the platform's per-user config directory. Not the desktop app's profile:
 * that one's master key is sealed by the app's own keychain entry, which no
 * other program can open.
 */
export function configDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.INFRAWRENCH_CONFIG_DIR) return path.resolve(env.INFRAWRENCH_CONFIG_DIR);
  const home = os.homedir();
  if (process.platform === "darwin") {
    return path.join(home, "Library", "Application Support", "infrawrench-cli");
  }
  if (process.platform === "win32") {
    return path.join(env.APPDATA || path.join(home, "AppData", "Roaming"), "infrawrench-cli");
  }
  return path.join(env.XDG_CONFIG_HOME || path.join(home, ".config"), "infrawrench-cli");
}

/**
 * `dir`, created owner-only if it is not there yet. It holds the session
 * database and, with no keychain to seal it, the key that decrypts it.
 */
function privateDir(dir: string): string {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

type PathName = "userData" | "home" | "temp";

export const app = {
  isPackaged: true,
  /** Nothing to wait for: there is no Chromium to start. */
  whenReady: (): Promise<void> => Promise.resolve(),
  getVersion: (): string => VERSION,
  getPath: (name: PathName): string => {
    switch (name) {
      case "userData":
        return privateDir(configDir());
      case "home":
        return os.homedir();
      case "temp":
        return os.tmpdir();
    }
  },
  getAppPath: (): string => path.dirname(process.execPath),
  exit: (code = 0): never => process.exit(code),
  quit: (): never => process.exit(0),
  /** There is no GUI to share a profile with: the lock is always ours. */
  requestSingleInstanceLock: (): boolean => true,
  releaseSingleInstanceLock: (): void => {},
  dock: undefined,
  commandLine: { appendSwitch: (_name: string, _value?: string): void => {} },
};

/**
 * No keychain integration: `isEncryptionAvailable()` is false, so
 * `main-utils.ts` keeps the master key in a 0600 file beside the database
 * (the path it already takes on a Linux desktop with no keyring), the way
 * other CLIs keep their tokens.
 */
export const safeStorage = {
  isEncryptionAvailable: (): boolean => false,
  encryptString: (_plain: string): Buffer => {
    throw new Error("safeStorage is not available in the standalone CLI");
  },
  decryptString: (_blob: Buffer): string => {
    throw new Error("safeStorage is not available in the standalone CLI");
  },
};

/** The command that opens a URL in the default browser, without a shell in between. */
export function openerFor(
  platform: NodeJS.Platform,
  url: string,
): { command: string; args: string[] } {
  if (platform === "darwin") return { command: "open", args: [url] };
  // `rundll32` hands the URL to the protocol's handler as one argument, where
  // `cmd /c start` would parse `&` in a query string as a command separator.
  if (platform === "win32")
    return { command: "rundll32", args: ["url.dll,FileProtocolHandler", url] };
  return { command: "xdg-open", args: [url] };
}

export const shell = {
  /**
   * Best effort: a headless host has no browser, and the caller has already
   * printed the URL for that case. Only http(s) URLs are opened.
   */
  openExternal: (url: string): Promise<void> => {
    if (!/^https?:\/\//i.test(url)) return Promise.resolve();
    const { command, args } = openerFor(process.platform, url);
    try {
      const child = spawn(command, args, { detached: true, stdio: "ignore" });
      child.on("error", () => {});
      child.unref();
    } catch {
      // No opener installed: the URL is on screen.
    }
    return Promise.resolve();
  },
};
