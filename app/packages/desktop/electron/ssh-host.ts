/**
 * SSH infrastructure host — registers IPC channels for:
 *   - SSH tunnels (port-forwarding for remote services)
 *   - SSH shell sessions (terminal access)
 *   - System SSH key discovery
 *
 * main.ts imports this module for its side effects only.
 */
import { ipcMain } from "electron";
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

ipcMain.handle("ssh_open_tunnel", (_e, config: SshTunnelConfig) => openTunnel(config));

ipcMain.handle("ssh_close_tunnel", (_e, { tunnelId }: { tunnelId: string }) => {
  closeTunnel(tunnelId);
  return { ok: true };
});

ipcMain.handle("ssh_get_active_tunnels", () => getActiveTunnels());

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

ipcMain.handle(
  "sftp_upload",
  (_e, { config, remotePath, data }: { config: SftpConfig; remotePath: string; data: Buffer }) =>
    sftpUpload(config, remotePath, data),
);

ipcMain.handle(
  "sftp_download",
  (
    _e,
    {
      config,
      remotePath,
      localPath,
    }: { config: SftpConfig; remotePath: string; localPath: string },
  ) => sftpDownload(config, remotePath, localPath),
);

const PRIVATE_KEY_HEADERS = [
  "-----BEGIN OPENSSH PRIVATE KEY-----",
  "-----BEGIN RSA PRIVATE KEY-----",
  "-----BEGIN EC PRIVATE KEY-----",
  "-----BEGIN DSA PRIVATE KEY-----",
];

const SKIP_FILES = new Set(["known_hosts", "known_hosts.old", "authorized_keys", "config"]);

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
      if (PRIVATE_KEY_HEADERS.some((h) => head.includes(h))) results.push({ name: filename });
    } catch {
      /* skip unreadable */
    }
  }
  return results;
});

ipcMain.handle("ssh_read_system_key", (_e, { name }: { name: string }) => {
  const keyPath = path.join(os.homedir(), ".ssh", path.basename(name));
  return fs.readFileSync(keyPath, "utf8");
});

ipcMain.handle("ssh_check_pageant", () => isPageantRunning());
