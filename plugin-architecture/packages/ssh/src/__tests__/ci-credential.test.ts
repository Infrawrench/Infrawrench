import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { CiCredentialRequest, CiLentValue, SshHostServices } from "@infrawrench/plugin-base";

import { lendSshHost } from "../ci-credential.js";

/** An Ed25519 public key as OpenSSH writes it, and its fingerprint. */
function publicKey(seed: number): { line: string; fingerprint: string } {
  const type = Buffer.from("ssh-ed25519");
  const point = Buffer.alloc(32, seed);
  const length = (n: number) => Buffer.from([0, 0, 0, n]);
  const blob = Buffer.concat([length(type.length), type, length(point.length), point]);
  const hash = createHash("sha256").update(blob).digest("base64").replace(/=+$/, "");
  return { line: `ssh-ed25519 ${blob.toString("base64")}`, fingerprint: `SHA256:${hash}` };
}

const pinned = publicKey(1);
const other = publicKey(2);
const key = "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----";

const request = (over: Partial<CiCredentialRequest> = {}): CiCredentialRequest => ({
  name: "web 1",
  alias: "web-1",
  ttlSeconds: 600,
  references: {},
  pinnedHostKey: async (host, port) =>
    (host === "203.0.113.5" && port === 2222) || (host === "web.example.com" && port === 22)
      ? pinned.fingerprint
      : null,
  ...over,
});

/** The host's SSH service, offering `offered` as the host's key. */
const ssh = (offered: string = pinned.line): SshHostServices => ({
  exec: async () => "",
  hostKey: async () => offered,
});

const text = (v: CiLentValue) =>
  typeof v === "string" ? v : v.map((p) => ("text" in p ? p.text : p.secret)).join("");

describe("lendSshHost", () => {
  it("writes the key, a config entry and the pinned host key as a known_hosts line", async () => {
    const lent = await lendSshHost(
      { host: "203.0.113.5", port: "2222", username: "deploy", privateKey: key },
      request(),
      ssh(),
    );
    const [keyFile, knownHosts, config] = lent.files;
    expect(keyFile).toEqual({ path: "/root/.ssh/iw_web-1", mode: "600", content: `${key}\n` });
    expect(knownHosts!.path).toBe("/root/.ssh/iw_web-1.known_hosts");
    expect(text(knownHosts!.content)).toBe(`[203.0.113.5]:2222 ${pinned.line}\n`);
    expect(text(config!.content)).toBe(
      [
        "Host web-1",
        "  HostName 203.0.113.5",
        "  Port 2222",
        "  User deploy",
        "  IdentityFile /root/.ssh/iw_web-1",
        "  IdentitiesOnly yes",
        "  StrictHostKeyChecking yes",
        "  UserKnownHostsFile /root/.ssh/iw_web-1.known_hosts",
        "",
      ].join("\n"),
    );
    // Nothing a client older than 8.5, or one that cannot fork, cannot read.
    expect(text(config!.content)).not.toContain("KnownHostsCommand");
    // The key is secret as a whole; the config and the host key are shown.
    expect(typeof keyFile!.content).toBe("string");
    expect(Array.isArray(knownHosts!.content)).toBe(true);
    expect(Array.isArray(config!.content)).toBe(true);
  });

  it("names a host on port 22 without its port, as OpenSSH looks it up", async () => {
    const lent = await lendSshHost({ host: "web.example.com", privateKey: key }, request(), ssh());
    expect(text(lent.files[1]!.content)).toBe(`web.example.com ${pinned.line}\n`);
  });

  it("jumps through the connection it goes through when that is lent too", async () => {
    const lent = await lendSshHost(
      { host: "203.0.113.5", port: "2222", privateKey: key, connectThroughAccountId: "acc-2" },
      request({ references: { connectThroughAccountId: "bastion" } }),
      ssh(),
    );
    expect(text(lent.files[2]!.content)).toContain("  ProxyJump bastion\n");
  });

  it("refuses a jump host that is not lent, a host with no pinned key, and a bad host", async () => {
    await expect(
      lendSshHost(
        { host: "203.0.113.5", port: "2222", privateKey: key, connectThroughAccountId: "acc-2" },
        request(),
        ssh(),
      ),
    ).rejects.toThrow("jump host that is not lent");
    await expect(
      lendSshHost({ host: "198.51.100.1", privateKey: key }, request(), ssh()),
    ).rejects.toThrow("No host key is pinned for 198.51.100.1:22");
    await expect(
      lendSshHost({ host: "evil\n  ProxyCommand x", privateKey: key }, request(), ssh()),
    ).rejects.toThrow("cannot go in an SSH config");
  });

  it("refuses a host key other than the pinned one, or none to read", async () => {
    const creds = { host: "203.0.113.5", port: "2222", privateKey: key };
    await expect(lendSshHost(creds, request(), ssh(other.line))).rejects.toThrow(
      `not the one pinned in Infrawrench (${pinned.fingerprint})`,
    );
    await expect(lendSshHost(creds, request(), ssh("ssh-ed25519 AAAA\nevil"))).rejects.toThrow(
      "is not an SSH public key",
    );
    await expect(lendSshHost(creds, request(), undefined)).rejects.toThrow(
      "cannot be read here to lend it",
    );
    await expect(
      lendSshHost(creds, request(), {
        exec: async () => "",
        hostKey: async () => {
          throw new Error("The host key of 203.0.113.5:2222 changed");
        },
      }),
    ).rejects.toThrow("changed");
  });
});
