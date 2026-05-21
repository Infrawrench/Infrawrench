import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CACHE_TTL_MS = 5_000;
let cached: { value: string | null; expiresAt: number } | null = null;

// Well-known 1Password SSH agent endpoints. 1Password advertises
// `~/.1password/agent.sock` (a symlink it creates) on every desktop OS;
// macOS's underlying socket lives inside the app group container.
function candidatePaths(): string[] {
  if (process.platform === "win32") {
    // 1Password on Windows speaks the OpenSSH named-pipe protocol on the
    // same pipe Microsoft's OpenSSH agent uses, so existence-checking can't
    // distinguish them — fall back to $SSH_AUTH_SOCK when set, otherwise
    // try the standard pipe.
    const envSock = process.env["SSH_AUTH_SOCK"];
    return envSock ? [envSock] : ["\\\\.\\pipe\\openssh-ssh-agent"];
  }
  const home = os.homedir();
  if (process.platform === "darwin") {
    return [
      path.join(home, ".1password/agent.sock"),
      path.join(home, "Library/Group Containers/2BUA8C4S2C.com.1password/t/agent.sock"),
    ];
  }
  // Linux + others. Cover the deb/rpm default and the snap path.
  return [
    path.join(home, ".1password/agent.sock"),
    path.join(home, "snap/1password/current/.1password/agent.sock"),
  ];
}

function pipeExists(p: string): boolean {
  // Named pipes on Windows aren't visible to fs.statSync, but fs.existsSync
  // returns true for them via NtCreateFile under the hood.
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

function socketExists(p: string): boolean {
  // The macOS path is a symlink to the real socket inside the group
  // container; statSync follows the link, so isSocket() is correct on the
  // resolved target. If statSync fails (broken link, missing), fall back to
  // lstat-based existsSync so dead symlinks still resolve to "not running".
  try {
    return fs.statSync(p).isSocket();
  } catch {
    return false;
  }
}

/**
 * Returns the 1Password SSH agent endpoint path (Unix socket on macOS/Linux,
 * named pipe on Windows) if one is reachable, otherwise null. Result is
 * cached briefly so repeated picker reloads don't hit the filesystem.
 */
export function get1PasswordAgentPath(): string | null {
  const now = Date.now();
  if (cached && cached.expiresAt > now) return cached.value;

  const candidates = candidatePaths();
  let found: string | null = null;
  for (const p of candidates) {
    if (process.platform === "win32" ? pipeExists(p) : socketExists(p)) {
      found = p;
      break;
    }
  }

  if (!found) {
    console.log(
      `[1password-agent] no agent socket found; checked: ${candidates.join(", ") || "(none)"}`,
    );
  } else {
    console.log(`[1password-agent] using ${found}`);
  }

  cached = { value: found, expiresAt: now + CACHE_TTL_MS };
  return found;
}

export function is1PasswordAgentRunning(): boolean {
  return get1PasswordAgentPath() !== null;
}
