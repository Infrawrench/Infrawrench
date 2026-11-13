/**
 * Lending an SSH host to a CI job: an `~/.ssh/config` entry named after the
 * connection, its private key, and a host key check against the key the
 * organization pinned in Infrawrench.
 *
 * - `Host <alias>` carries the address, port, user, the key
 *   (`/root/.ssh/iw_<alias>`, `IdentitiesOnly`) and, when the connection goes
 *   through another SSH connection that is lent to the same job,
 *   `ProxyJump <that alias>`. A job reaches public addresses only, so a host
 *   on a private network is reached through a public jump host this way.
 * - Host key checking stays on (`StrictHostKeyChecking yes`). Infrawrench
 *   pins a fingerprint, not a whole key, so the entry checks it with
 *   `KnownHostsCommand` (OpenSSH 8.5 and later), whose `%f` is the offered
 *   key's SHA-256 fingerprint: the command vouches for the offered key (`%H
 *   %t %K`) only when that fingerprint is the pinned one, and otherwise says
 *   nothing, which makes ssh refuse the host. A host with nothing pinned is
 *   not lent at all.
 *
 * The private key is a secret as a whole; the config entry and the check are
 * shown, since they hold nothing secret.
 */
import type { CiCredentialRequest, CiLentMaterial } from "@infrawrench/plugin-base";

export interface SshLendCredentials {
  host: string;
  port?: string;
  username?: string;
  privateKey?: string;
  connectThroughAccountId?: string;
}

const SAFE = /^[A-Za-z0-9._@:[\]-]+$/;

function configValue(value: string, what: string): string {
  if (!SAFE.test(value))
    throw new Error(`The connection's ${what} cannot go in an SSH config: ${value}`);
  return value;
}

export async function lendSshHost(
  creds: SshLendCredentials,
  request: CiCredentialRequest,
): Promise<CiLentMaterial> {
  if (!creds.privateKey?.trim()) {
    throw new Error("The connection has no private key to lend.");
  }
  const host = configValue(creds.host.trim(), "host");
  const portText = creds.port?.trim() || "22";
  const port = Number(portText);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`The connection's port is not a port: ${portText}`);
  }
  const user = configValue(creds.username?.trim() || "root", "user");
  const fingerprint = await request.pinnedHostKey(host, port);
  if (!fingerprint) {
    throw new Error(
      `No host key is pinned for ${host}:${port} in Infrawrench. Open a terminal to it from Infrawrench once to pin it, then run the job again.`,
    );
  }
  if (!/^SHA256:[A-Za-z0-9+/]+=*$/.test(fingerprint)) {
    throw new Error(`The pinned host key for ${host}:${port} is not a SHA-256 fingerprint.`);
  }
  const alias = request.alias;
  const keyPath = `/root/.ssh/iw_${alias}`;
  const checkPath = `/root/.ssh/iw_${alias}.hostkey`;
  const via = creds.connectThroughAccountId
    ? request.references["connectThroughAccountId"]
    : undefined;
  if (creds.connectThroughAccountId && !via) {
    throw new Error("The connection goes through a jump host that is not lent to this job.");
  }
  const lines = [
    `Host ${alias}`,
    `  HostName ${host}`,
    `  Port ${port}`,
    `  User ${user}`,
    `  IdentityFile ${keyPath}`,
    "  IdentitiesOnly yes",
    "  StrictHostKeyChecking yes",
    `  KnownHostsCommand /bin/sh ${checkPath} %H %f %t %K`,
    ...(via ? [`  ProxyJump ${via}`] : []),
    "",
  ];
  const check = [
    "#!/bin/sh",
    `# The host key Infrawrench pinned for ${host}:${port}.`,
    `[ "$2" = "${fingerprint}" ] && printf '%s %s %s\\n' "$1" "$3" "$4"`,
    "exit 0",
    "",
  ].join("\n");
  const key = creds.privateKey.endsWith("\n") ? creds.privateKey : `${creds.privateKey}\n`;
  return {
    env: {},
    files: [
      { path: keyPath, mode: "600", content: key },
      { path: checkPath, mode: "600", content: [{ text: check }] },
      { path: "/root/.ssh/config", mode: "600", content: [{ text: lines.join("\n") }] },
    ],
    summary: `the stored private key for ${user}@${host}:${port}`,
  };
}
