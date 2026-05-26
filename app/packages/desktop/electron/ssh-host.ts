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
import { OpenSSHAgent, type ParsedKey } from "ssh2";
import { isPageantRunning } from "./pageant";
import { get1PasswordAgentPath, is1PasswordAgentRunning } from "./onepassword-agent";
import { isDialogBlessedPath } from "./main-utils";

ipcMain.handle("ssh_open_tunnel", (_e, config: SshTunnelConfig) => openTunnel(config));

ipcMain.handle("ssh_close_tunnel", (_e, { tunnelId }: { tunnelId: string }) => {
  closeTunnel(tunnelId);
  return { ok: true };
});

ipcMain.handle("ssh_get_active_tunnels", () => getActiveTunnels());

// `ssh_exec_command` runs arbitrary command strings over SSH. Callers
// (DockerSetupModal, SshEnvDeployModal) need multi-step provisioning — install
// Docker, write systemd units, deploy .env files. Replace with narrower typed
// operations when possible.
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
  // No dialog-blessed-path check — the renderer hands over a Buffer, not a local path.
  (_e, { config, remotePath, data }: { config: SftpConfig; remotePath: string; data: Buffer }) =>
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

// Without this gating, a compromised renderer could enumerate ~/.ssh/* by
// guessing filenames. Reads outside the allowlist fall through to a confirm dialog.
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

ipcMain.handle("ssh_check_1password", () => is1PasswordAgentRunning());

/**
 * Wire shape for `ssh_list_1password_keys` IPC. The renderer-side mirror is
 * `AgentSshKey` exported from `@infrawrench/ui` (see
 * `app/packages/ui/src/components/create-resource/SshKeyPicker.tsx`). The two
 * shapes must stay in sync — keep this definition identical to the UI one
 * (the renderer treats `keyType` as optional, which is a superset of this).
 */
interface AgentSshKey {
  name: string;
  publicKey: string;
  keyType: string;
}

// ssh2's OpenSSHAgent.getIdentities returns `Array<ParsedKey | PublicKeyEntry>`
// per its types; the runtime hands back ParsedKey instances. Narrow by
// looking for the ParsedKey shape and unwrap the PublicKeyEntry case if
// needed.
function toParsedKey(entry: unknown): ParsedKey | null {
  if (entry && typeof entry === "object" && "getPublicSSH" in entry) {
    return entry as ParsedKey;
  }
  if (entry && typeof entry === "object" && "pubKey" in entry) {
    const inner = (entry as { pubKey: unknown }).pubKey;
    if (inner && typeof inner === "object" && "getPublicSSH" in inner) {
      return inner as ParsedKey;
    }
  }
  return null;
}

// Lists the public keys 1Password currently holds, by speaking the OpenSSH
// agent protocol over its socket. Used by the create-resource SSH-key picker
// so the user can install a 1Password-managed pubkey on a new VM without
// having to copy it out of the 1Password app by hand.
ipcMain.handle("ssh_list_1password_keys", async (): Promise<AgentSshKey[]> => {
  const sock = get1PasswordAgentPath();
  if (!sock) return [];
  return new Promise<AgentSshKey[]>((resolve) => {
    let settled = false;
    const finish = (keys: AgentSshKey[]) => {
      if (settled) return;
      settled = true;
      resolve(keys);
    };
    try {
      const agent = new OpenSSHAgent(sock);
      // Hedge against an unresponsive agent so the picker isn't blocked.
      const timer = setTimeout(() => {
        console.warn("[1password-agent] getIdentities timed out");
        finish([]);
      }, 2_000);
      agent.getIdentities((err, identities) => {
        clearTimeout(timer);
        if (err || !identities) {
          if (err) console.warn(`[1password-agent] getIdentities failed: ${err.message}`);
          finish([]);
          return;
        }
        const out: AgentSshKey[] = [];
        identities.forEach((entry, i) => {
          const parsed = toParsedKey(entry);
          if (!parsed) return;
          const b64 = parsed.getPublicSSH().toString("base64");
          const comment = parsed.comment ?? "";
          const openssh = `${parsed.type} ${b64}${comment ? ` ${comment}` : ""}`;
          const name = (comment.trim() || `1password-${i + 1}`).slice(0, 64);
          out.push({ name, publicKey: openssh, keyType: parsed.type });
        });
        finish(out);
      });
    } catch (e) {
      console.warn(`[1password-agent] OpenSSHAgent threw: ${(e as Error).message}`);
      finish([]);
    }
  });
});
