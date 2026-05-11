/**
 * SSH infrastructure host — registers IPC channels for:
 *   - SSH tunnels (port-forwarding for remote services)
 *   - SSH shell sessions (terminal access)
 *   - System SSH key discovery
 *
 * main.ts imports this module for its side effects only.
 */
import { dialog, ipcMain } from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openTunnel, closeTunnel, getActiveTunnels, sshExecCommand } from "./ssh-tunnel";
import {
  spawnSshShell,
  writeSshShell,
  resizeSshShell,
  killSshShell,
  type SshShellConfig,
} from "./ssh-shell";
import { sftpList, sftpMkdir, sftpDelete, sftpUpload, sftpDownload } from "./sftp";
import type { SftpConfig, SshTunnelConfig } from "@infrawrench/plugin-base" with {
  "resolution-mode": "import",
};
import { isPageantRunning } from "./pageant";
import { isDialogBlessedPath } from "./main-utils";

ipcMain.handle("ssh_open_tunnel", (_e, config: SshTunnelConfig) => openTunnel(config));

ipcMain.handle("ssh_close_tunnel", (_e, { tunnelId }: { tunnelId: string }) => {
  closeTunnel(tunnelId);
  return { ok: true };
});

ipcMain.handle("ssh_get_active_tunnels", () => getActiveTunnels());

// FIX_FLAG: `ssh_exec_command` accepts an arbitrary command string and runs it
// over SSH as the supplied user. The original intent (per the inline comment
// in earlier revisions) was "check if Docker is installed", but real callers
// (DockerSetupModal, SshEnvDeployModal) run multi-step provisioning scripts
// — installing Docker, writing systemd units, deploying .env files, etc.
//
// Removing this channel would break those flows, so it stays for now, but it
// is the highest-priority candidate for replacement with narrower typed
// operations. A `ssh_check_docker_installed` channel is provided below so
// the simple "is Docker present?" check no longer needs the generic path.
ipcMain.handle(
  "ssh_exec_command",
  (
    _e,
    {
      config,
      command,
    }: {
      config: { sshHost: string; sshPort: number; sshUser: string; privateKey: string };
      command: string;
    },
  ) => sshExecCommand(config, command),
);

ipcMain.handle(
  "ssh_check_docker_installed",
  async (
    _e,
    {
      config,
    }: {
      config: { sshHost: string; sshPort: number; sshUser: string; privateKey: string };
    },
  ): Promise<{ installed: boolean; version: string | null }> => {
    const { stdout, code } = await sshExecCommand(config, "docker --version 2>/dev/null");
    const installed = code === 0 && stdout.includes("Docker");
    return { installed, version: installed ? stdout.trim() : null };
  },
);

ipcMain.handle("ssh_shell_spawn", (event, config: SshShellConfig) =>
  spawnSshShell(event.sender, config),
);

ipcMain.handle("ssh_shell_write", (_e, { shellId, data }: { shellId: string; data: string }) => {
  writeSshShell(shellId, data);
});

ipcMain.handle(
  "ssh_shell_resize",
  (_e, { shellId, cols, rows }: { shellId: string; cols: number; rows: number }) => {
    resizeSshShell(shellId, cols, rows);
  },
);

ipcMain.handle("ssh_shell_kill", (_e, { shellId }: { shellId: string }) => {
  killSshShell(shellId);
});

ipcMain.handle("sftp_list", (_e, { config, path }: { config: SftpConfig; path: string }) =>
  sftpList(config, path),
);

ipcMain.handle("sftp_mkdir", (_e, { config, path }: { config: SftpConfig; path: string }) =>
  sftpMkdir(config, path),
);

ipcMain.handle(
  "sftp_delete",
  (_e, { config, path, isDir }: { config: SftpConfig; path: string; isDir: boolean }) =>
    sftpDelete(config, path, isDir),
);

async function ensureLocalPathAllowed(localPath: string, description: string): Promise<void> {
  if (isDialogBlessedPath(localPath)) return;
  const choice = await dialog.showMessageBox({
    type: "warning",
    title: "Confirm local file access",
    message: `Infrawrench wants to ${description}.`,
    detail: localPath,
    buttons: ["Allow", "Cancel"],
    defaultId: 1,
    cancelId: 1,
  });
  if (choice.response !== 0) {
    throw new Error(`Local file access denied for ${localPath}`);
  }
}

ipcMain.handle(
  "sftp_upload",
  (_e, { config, remotePath, data }: { config: SftpConfig; remotePath: string; data: Buffer }) =>
    // sftp_upload takes the file body as a Buffer over IPC; the renderer is
    // not handing the main process a local-disk path here, so we don't need
    // the dialog-blessed-path check.
    sftpUpload(config, remotePath, data),
);

ipcMain.handle(
  "sftp_download",
  async (
    _e,
    {
      config,
      remotePath,
      localPath,
    }: { config: SftpConfig; remotePath: string; localPath: string },
  ) => {
    await ensureLocalPathAllowed(localPath, `write the downloaded file to`);
    return sftpDownload(config, remotePath, localPath);
  },
);

const PRIVATE_KEY_HEADERS = [
  "-----BEGIN OPENSSH PRIVATE KEY-----",
  "-----BEGIN RSA PRIVATE KEY-----",
  "-----BEGIN EC PRIVATE KEY-----",
  "-----BEGIN DSA PRIVATE KEY-----",
];

const SKIP_FILES = new Set(["known_hosts", "known_hosts.old", "authorized_keys", "config"]);

// Names returned from the most recent `ssh_list_system_keys` call. Reads via
// `ssh_read_system_key` must reference a name that appeared in this set (or
// its `.pub` counterpart) — otherwise we fall back to a user confirmation
// dialog. Without this gating, a compromised renderer could enumerate
// `~/.ssh/*` simply by guessing filenames.
const SYSTEM_KEY_NAME_ALLOWLIST = new Set<string>();

function rememberSystemKeyName(name: string): void {
  SYSTEM_KEY_NAME_ALLOWLIST.add(name);
  SYSTEM_KEY_NAME_ALLOWLIST.add(`${name}.pub`);
}

ipcMain.handle("ssh_list_system_keys", () => {
  const sshDir = path.join(os.homedir(), ".ssh");
  if (!fs.existsSync(sshDir)) return [];
  const results: { name: string }[] = [];
  for (const filename of fs.readdirSync(sshDir)) {
    if (filename.endsWith(".pub") || SKIP_FILES.has(filename)) continue;
    try {
      const filePath = path.join(sshDir, filename);
      if (!fs.statSync(filePath).isFile()) continue;
      const head = fs.readFileSync(filePath, "utf8").slice(0, 100);
      if (PRIVATE_KEY_HEADERS.some((h) => head.includes(h))) {
        results.push({ name: filename });
        rememberSystemKeyName(filename);
      }
    } catch {
      /* skip unreadable */
    }
  }
  return results;
});

ipcMain.handle("ssh_read_system_key", async (_e, { name }: { name: string }) => {
  const base = path.basename(name);
  if (!SYSTEM_KEY_NAME_ALLOWLIST.has(base)) {
    const choice = await dialog.showMessageBox({
      type: "warning",
      title: "Confirm SSH key read",
      message: `Infrawrench wants to read ~/.ssh/${base}.`,
      detail:
        "This file was not in the last directory listing. Only allow this if you initiated the request.",
      buttons: ["Allow", "Cancel"],
      defaultId: 1,
      cancelId: 1,
    });
    if (choice.response !== 0) {
      throw new Error(`Read of ~/.ssh/${base} denied`);
    }
    rememberSystemKeyName(base.endsWith(".pub") ? base.slice(0, -4) : base);
  }
  const keyPath = path.join(os.homedir(), ".ssh", base);
  return fs.readFileSync(keyPath, "utf8");
});

ipcMain.handle("ssh_check_pageant", () => isPageantRunning());
