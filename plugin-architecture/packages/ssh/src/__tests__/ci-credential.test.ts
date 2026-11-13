import { describe, expect, it } from "vitest";
import type { CiCredentialRequest, CiLentValue } from "@infrawrench/plugin-base";

import { lendSshHost } from "../ci-credential.js";

const FP = "SHA256:47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU";
const key = "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----";

const request = (over: Partial<CiCredentialRequest> = {}): CiCredentialRequest => ({
  name: "web 1",
  alias: "web-1",
  ttlSeconds: 600,
  references: {},
  pinnedHostKey: async (host, port) => (host === "203.0.113.5" && port === 2222 ? FP : null),
  ...over,
});

const text = (v: CiLentValue) =>
  typeof v === "string" ? v : v.map((p) => ("text" in p ? p.text : p.secret)).join("");

describe("lendSshHost", () => {
  it("writes the key, a config entry and a pinned host key check", async () => {
    const lent = await lendSshHost(
      { host: "203.0.113.5", port: "2222", username: "deploy", privateKey: key },
      request(),
    );
    const [keyFile, check, config] = lent.files;
    expect(keyFile).toEqual({ path: "/root/.ssh/iw_web-1", mode: "600", content: `${key}\n` });
    expect(text(config!.content)).toBe(
      [
        "Host web-1",
        "  HostName 203.0.113.5",
        "  Port 2222",
        "  User deploy",
        "  IdentityFile /root/.ssh/iw_web-1",
        "  IdentitiesOnly yes",
        "  StrictHostKeyChecking yes",
        "  KnownHostsCommand /bin/sh /root/.ssh/iw_web-1.hostkey %H %f %t %K",
        "",
      ].join("\n"),
    );
    expect(text(check!.content)).toContain(`[ "$2" = "${FP}" ]`);
    // The key is secret as a whole; the config is shown.
    expect(typeof keyFile!.content).toBe("string");
    expect(Array.isArray(config!.content)).toBe(true);
  });

  it("jumps through the connection it goes through when that is lent too", async () => {
    const lent = await lendSshHost(
      { host: "203.0.113.5", port: "2222", privateKey: key, connectThroughAccountId: "acc-2" },
      request({ references: { connectThroughAccountId: "bastion" } }),
    );
    expect(text(lent.files[2]!.content)).toContain("  ProxyJump bastion\n");
  });

  it("refuses a jump host that is not lent, a host with no pinned key, and a bad host", async () => {
    await expect(
      lendSshHost(
        { host: "203.0.113.5", port: "2222", privateKey: key, connectThroughAccountId: "acc-2" },
        request(),
      ),
    ).rejects.toThrow("jump host that is not lent");
    await expect(lendSshHost({ host: "198.51.100.1", privateKey: key }, request())).rejects.toThrow(
      "No host key is pinned for 198.51.100.1:22",
    );
    await expect(
      lendSshHost({ host: "evil\n  ProxyCommand x", privateKey: key }, request()),
    ).rejects.toThrow("cannot go in an SSH config");
  });
});
