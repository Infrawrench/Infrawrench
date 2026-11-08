// Installs the `infrawrench` shell command: a tiny shim script on PATH that
// execs the desktop app binary with --cli (the VS Code `code` model). Shared
// by the GUI ("Install shell command" in the sidebar footer) and the CLI
// (`infrawrench cli install`), so both stay in sync.
import { app } from "electron";
import { execFile } from "node:child_process";
import { Context, Effect, Layer } from "effect";
import {
  ShellCommandError,
  type ShellCommandInstallResult,
  type ShellCommandStatus,
} from "../shared/rpc/groups/shell-command";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SHELL_COMMAND_NAME = "infrawrench";

/** The binary the shim should exec. In dev this is the electron binary. */
function appBinaryPath(): string {
  return process.execPath;
}

// Packaged: exec the app binary directly. Dev: the electron binary needs the
// app path as its first argument to load our bundle.
function launchArgs(): string {
  return app.isPackaged ? "" : ` "${app.getAppPath()}"`;
}

function posixShimContent(): string {
  // exec so the CLI inherits the terminal's stdio and exit code directly.
  return `#!/bin/sh\n# Installed by Infrawrench. Launches the desktop app in CLI mode.\nexec "${appBinaryPath()}"${launchArgs()} --cli "$@"\n`;
}

function windowsShimContent(): string {
  return `@echo off\r\nrem Installed by Infrawrench. Launches the desktop app in CLI mode.\r\n"${appBinaryPath()}"${launchArgs()} --cli %*\r\n`;
}

function candidateDirsPosix(): string[] {
  return ["/usr/local/bin", path.join(os.homedir(), ".local", "bin")];
}

function windowsBinDir(): string {
  return path.join(app.getPath("userData"), "bin");
}

function readShellCommandStatus(): ShellCommandStatus {
  const targets =
    process.platform === "win32"
      ? [path.join(windowsBinDir(), `${SHELL_COMMAND_NAME}.cmd`)]
      : candidateDirsPosix().map((d) => path.join(d, SHELL_COMMAND_NAME));
  for (const target of targets) {
    try {
      const content = fs.readFileSync(target, "utf8");
      if (!content.includes("Installed by Infrawrench")) continue;
      return { installed: true, path: target, stale: !content.includes(appBinaryPath()) };
    } catch {
      /* not present here */
    }
  }
  return { installed: false, path: null, stale: false };
}

function isDirWritable(dir: string): boolean {
  try {
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Write the shim. POSIX: prefer /usr/local/bin, fall back to ~/.local/bin
 * (created if missing) when /usr/local/bin isn't writable; no privilege
 * escalation, ever. Windows: userData\bin plus a user-level PATH append.
 */
async function writeShellCommand(): Promise<ShellCommandInstallResult> {
  if (process.platform === "win32") {
    const dir = windowsBinDir();
    fs.mkdirSync(dir, { recursive: true });
    const target = path.join(dir, `${SHELL_COMMAND_NAME}.cmd`);
    fs.writeFileSync(target, windowsShimContent(), "utf8");
    const added = await addToWindowsUserPath(dir);
    return {
      path: target,
      note: added
        ? "Open a new terminal for PATH changes to take effect."
        : `Add ${dir} to your PATH to use \`${SHELL_COMMAND_NAME}\` from any terminal.`,
    };
  }

  for (const dir of candidateDirsPosix()) {
    const isHomeBin = dir !== "/usr/local/bin";
    if (isHomeBin) fs.mkdirSync(dir, { recursive: true });
    if (!isDirWritable(dir)) continue;
    const target = path.join(dir, SHELL_COMMAND_NAME);
    // Refuse to clobber an unrelated binary with the same name.
    if (fs.existsSync(target)) {
      const existing = fs.readFileSync(target, "utf8");
      if (!existing.includes("Installed by Infrawrench")) {
        throw new Error(`${target} already exists and wasn't installed by Infrawrench.`);
      }
    }
    fs.writeFileSync(target, posixShimContent(), { encoding: "utf8", mode: 0o755 });
    fs.chmodSync(target, 0o755);
    const onPath = (process.env.PATH ?? "").split(path.delimiter).includes(dir);
    return {
      path: target,
      note: onPath ? null : `Add ${dir} to your PATH to use \`${SHELL_COMMAND_NAME}\`.`,
    };
  }
  throw new Error(
    "No writable install location (/usr/local/bin or ~/.local/bin). Create ~/.local/bin and retry.",
  );
}

function removeShellCommand(): string | null {
  const status = readShellCommandStatus();
  if (!status.installed || !status.path) return null;
  fs.unlinkSync(status.path);
  return status.path;
}

/** Append a dir to the user's PATH via PowerShell (no elevation needed). */
function addToWindowsUserPath(dir: string): Promise<boolean> {
  const script = `$p=[Environment]::GetEnvironmentVariable('Path','User'); if(($p -split ';') -notcontains '${dir}'){[Environment]::SetEnvironmentVariable('Path', ($p.TrimEnd(';') + ';${dir}'), 'User')}`;
  return new Promise((resolve) => {
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], (err) => {
      resolve(!err);
    });
  });
}

const shellCommandError = (cause: unknown) =>
  new ShellCommandError({ message: cause instanceof Error ? cause.message : String(cause) });

/**
 * The `infrawrench` shim on the user's PATH. File-system work runs on Node's
 * own `fs` (the desktop takes no Effect platform package), wrapped so a
 * refusal (an unrelated binary in the way, no writable directory) is a typed
 * `ShellCommandError` the renderer can show.
 */
export class ShellCommand extends Context.Service<
  ShellCommand,
  {
    readonly status: Effect.Effect<ShellCommandStatus>;
    readonly install: Effect.Effect<ShellCommandInstallResult, ShellCommandError>;
    readonly uninstall: Effect.Effect<string | null, ShellCommandError>;
  }
>()("infrawrench/desktop/ShellCommand") {
  static readonly layer = Layer.succeed(ShellCommand)(
    ShellCommand.of({
      status: Effect.sync(readShellCommandStatus),
      install: Effect.tryPromise({ try: writeShellCommand, catch: shellCommandError }),
      uninstall: Effect.try({ try: removeShellCommand, catch: shellCommandError }),
    }),
  );
}
