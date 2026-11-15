/**
 * Lending an SSH host to a CI job: an `~/.ssh/config` entry named after the
 * connection, its private key, and the host's pinned key as a `known_hosts`
 * line.
 *
 * - `Host <alias>` carries the address, port, user, the key
 *   (`/root/.ssh/iw_<alias>`, `IdentitiesOnly`) and, when the connection goes
 *   through another SSH connection that is lent to the same job,
 *   `ProxyJump <that alias>`. A job reaches public addresses only, so a host
 *   on a private network is reached through a public jump host this way.
 * - Host key checking stays on (`StrictHostKeyChecking yes`) against a file of
 *   the entry's own (`UserKnownHostsFile /root/.ssh/iw_<alias>.known_hosts`)
 *   holding one line: the key the host offers, read by the host's SSH service
 *   through the same jump hosts and handed out only when its fingerprint is
 *   the one the organization pinned (Infrawrench pins a fingerprint, not a
 *   key). It is checked against the pin here once more. Any `ssh` reads such
 *   a line, the runner's `builtin:ssh` included, which cannot run a
 *   `KnownHostsCommand` (#1196). A host with nothing pinned, or one that now
 *   offers another key, is not lent at all.
 *
 * The private key is a secret as a whole; the config entry and the host key
 * are shown, since they hold nothing secret.
 */
import type {
  CiCredentialRequest,
  CiLentMaterial,
  SshHostServices,
} from "@infrawrench/plugin-base";

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

/** `SHA256:...` of an OpenSSH public key (`<type> <base64>`), as `ssh-keygen -l` prints it. */
async function fingerprintOf(publicKey: string): Promise<string> {
  const blob = Uint8Array.from(atob(publicKey.split(" ")[1] ?? ""), (c) => c.charCodeAt(0));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", blob));
  return `SHA256:${btoa(String.fromCharCode(...digest)).replace(/=+$/, "")}`;
}

export async function lendSshHost(
  creds: SshLendCredentials,
  request: CiCredentialRequest,
  ssh: SshHostServices | undefined,
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
  const via = creds.connectThroughAccountId
    ? request.references["connectThroughAccountId"]
    : undefined;
  if (creds.connectThroughAccountId && !via) {
    throw new Error("The connection goes through a jump host that is not lent to this job.");
  }
  if (!ssh?.hostKey) {
    throw new Error(`The host key of ${host}:${port} cannot be read here to lend it.`);
  }
  const hostKey = (await ssh.hostKey()).trim();
  if (!/^[a-z0-9@.-]+ [A-Za-z0-9+/]+=*$/.test(hostKey)) {
    throw new Error(`The host key read from ${host}:${port} is not an SSH public key.`);
  }
  if ((await fingerprintOf(hostKey)) !== fingerprint.replace(/=+$/, "")) {
    throw new Error(
      `The host key read from ${host}:${port} is not the one pinned in Infrawrench (${fingerprint}).`,
    );
  }
  const alias = request.alias;
  const keyPath = `/root/.ssh/iw_${alias}`;
  const knownHostsPath = `/root/.ssh/iw_${alias}.known_hosts`;
  const lines = [
    `Host ${alias}`,
    `  HostName ${host}`,
    `  Port ${port}`,
    `  User ${user}`,
    `  IdentityFile ${keyPath}`,
    "  IdentitiesOnly yes",
    "  StrictHostKeyChecking yes",
    `  UserKnownHostsFile ${knownHostsPath}`,
    ...(via ? [`  ProxyJump ${via}`] : []),
    "",
  ];
  // OpenSSH looks a host on another port than 22 up as `[host]:port`.
  const pattern = port === 22 ? host : `[${host}]:${port}`;
  const key = creds.privateKey.endsWith("\n") ? creds.privateKey : `${creds.privateKey}\n`;
  return {
    env: {},
    files: [
      { path: keyPath, mode: "600", content: key },
      { path: knownHostsPath, mode: "600", content: [{ text: `${pattern} ${hostKey}\n` }] },
      { path: "/root/.ssh/config", mode: "600", content: [{ text: lines.join("\n") }] },
    ],
    summary: `the stored private key for ${user}@${host}:${port}`,
  };
}
