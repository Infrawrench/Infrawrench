import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import * as net from "node:net";
import type { TunnelPlan } from "@infrawrench/ssh-tunnel-core";

import { fakePostgres } from "./helpers/fake-postgres";

process.env["ENCRYPTION_MASTER_KEY"] = randomBytes(32).toString("base64");

// Real Drizzle over a recording driver against the real schema: the
// ssh_tunnel_configs lookup renders its actual SQL (and shadow-validates
// under test:postgres:shadow). A test with a tunnel queues its config row
// (the remote end the rewriter matches against); the others get the default
// empty result (no config row).
const pg = fakePostgres();

/** The account's tunnel config, in the table's column order. */
function tunnelConfig(remoteHost: string, remotePort: number) {
  return {
    id: "t1",
    accountId: "acct1",
    organizationId: "org1",
    sshHost: "bastion.example.com",
    sshPort: 22,
    sshUser: "root",
    remoteHost,
    remotePort,
    encryptedPrivateKey: "ENC",
    privateKeyIv: "IV",
    createdAt: "2026-11-01 00:00:00.000",
  };
}

const field = (key: string, tunnel?: "address" | "kubeconfig") => ({
  key,
  label: key,
  sensitive: false,
  ...(tunnel ? { tunnel } : {}),
});
vi.mock("../db/client", () => ({ db: pg.db }));

// --- mock ssh-tunnel-core (real module pulls in ssh2 which breaks ESM import) ---
const findTunnel = vi.fn();
const ensureTunnel = vi.fn();
vi.mock("@infrawrench/ssh-tunnel-core", () => ({
  findTunnel: (...a: unknown[]) => findTunnel(...a),
  ensureTunnel: (...a: unknown[]) => ensureTunnel(...a),
}));

// The organization's pinned host keys, read from the database by the real one.
const pinnedKeyVerifier = vi.fn(() => "pinned-verifier");
vi.mock("../ssh-exec", () => ({
  databasePins: (organizationId: string) => `pins:${organizationId}`,
  pinnedKeyVerifier: (...a: unknown[]) => pinnedKeyVerifier(...(a as [])),
}));

// The bastion host check resolves DNS; these tests are about what is rewritten.
vi.mock("../egress-guard", () => ({ resolveSafeHost: async (host: string) => host }));

let rewriteCredentialsThroughTunnel: typeof import("../tunnel-resolver").rewriteCredentialsThroughTunnel;
let rewriteConnectionForTunnel: typeof import("../tunnel-resolver").rewriteConnectionForTunnel;

beforeEach(async () => {
  vi.clearAllMocks();
  pg.reset();
  const mod = await import("../tunnel-resolver");
  rewriteCredentialsThroughTunnel = mod.rewriteCredentialsThroughTunnel;
  rewriteConnectionForTunnel = mod.rewriteConnectionForTunnel;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("rewriteConnectionForTunnel", () => {
  it("returns the original string when no tunnel exists (existing + no config)", async () => {
    findTunnel.mockReturnValue(null);
    // default empty result: no ssh_tunnel_configs row
    const out = await rewriteConnectionForTunnel("acct1", "postgres://u:p@db.example.com:5432/app");
    expect(out).toBe("postgres://u:p@db.example.com:5432/app");
    expect(pg.lastQuery().sql).toContain('from "ssh_tunnel_configs"');
    // accountId, and the parameterized limit 1.
    expect(pg.lastQuery().params).toEqual(["acct1", 1]);
  });

  it("rewrites a URL connection string to 127.0.0.1:<localPort> when an existing tunnel is found", async () => {
    pg.queueRows([tunnelConfig("db.example.com", 5432)]);
    findTunnel.mockReturnValue({ localPort: 15432, extras: { accountId: "acct1" } });
    const out = await rewriteConnectionForTunnel("acct1", "postgres://u:p@db.example.com:5432/app");
    expect(out).toBe("postgres://u:p@127.0.0.1:15432/app");
    expect(ensureTunnel).not.toHaveBeenCalled();
  });

  it("rewrites a tcp:// URL to 127.0.0.1:<localPort>", async () => {
    pg.queueRows([tunnelConfig("db.internal", 5432)]);
    findTunnel.mockReturnValue({ localPort: 16000, extras: { accountId: "acct1" } });
    const out = await rewriteConnectionForTunnel("acct1", "tcp://db.internal:5432");
    expect(out).toBe("tcp://127.0.0.1:16000");
  });

  it("rewrites a bare host:port, with a dotted name or an IP", async () => {
    for (const written of ["1.2.3.4:5432", "db.internal:5432"]) {
      pg.queueRows([tunnelConfig("10.0.0.5", 5432)]);
      findTunnel.mockReturnValue({ localPort: 16000, extras: { accountId: "acct1" } });
      expect(await rewriteConnectionForTunnel("acct1", written)).toBe("127.0.0.1:16000");
    }
  });

  it("leaves a value that is no address untouched", async () => {
    for (const written of ["unix:///var/run/docker.sock", "host=db port=5432", "a b:1"]) {
      pg.queueRows([tunnelConfig("db.internal", 5432)]);
      findTunnel.mockReturnValue({ localPort: 16000, extras: { accountId: "acct1" } });
      expect(await rewriteConnectionForTunnel("acct1", written)).toBe(written);
    }
  });

  it("is the same rewritten twice: an address at the local end stays put", async () => {
    pg.queueRows([tunnelConfig("db.internal", 5432)]);
    findTunnel.mockReturnValue({ localPort: 16000, extras: { accountId: "acct1" } });
    const out = await rewriteConnectionForTunnel("acct1", "redis://127.0.0.1:16000/0");
    expect(out).toBe("redis://127.0.0.1:16000/0");
  });

  it("opens the tunnel the config describes when none is open", async () => {
    // A local stand-in for the bastion, so the plan's dial lands somewhere.
    const bastion = net.createServer((socket) => socket.destroy());
    await new Promise<void>((r) => bastion.listen(0, "127.0.0.1", r));
    const bastionPort = (bastion.address() as net.AddressInfo).port;
    const { encrypt, buildAad } = await import("../encryption");
    const sealed = await encrypt("KEY", buildAad("sshTunnelConfig", "t1", "privateKey"));
    pg.queueRows([
      {
        ...tunnelConfig("10.0.0.5", 6379),
        sshHost: "127.0.0.1",
        sshPort: bastionPort,
        encryptedPrivateKey: sealed.ciphertext,
        privateKeyIv: sealed.iv,
      },
    ]);
    findTunnel.mockReturnValue(null);
    let planned: TunnelPlan<unknown> | undefined;
    ensureTunnel.mockImplementation(
      async (_key: string, plan: () => Promise<TunnelPlan<unknown>>) => {
        planned = await plan();
        return { tunnelId: "x", localPort: 17000 };
      },
    );
    try {
      const out = await rewriteConnectionForTunnel("acct1", "redis://:pw@10.0.0.5:6379");
      expect(out).toBe("redis://:pw@127.0.0.1:17000");
      // One tunnel per account and config, which the core reopens when it drops.
      expect(ensureTunnel.mock.calls[0]![0]).toBe("org1:acct1:t1");
      expect(planned!.config).toMatchObject({
        privateKey: "KEY",
        remoteHost: "10.0.0.5",
        remotePort: 6379,
      });
      expect(planned!.extras).toEqual({ organizationId: "org1", accountId: "acct1" });
      // Dialled to the vetted address, verified against the organization's pins.
      const connect = planned!.options!.configureConnect!({ host: "127.0.0.1", port: bastionPort });
      expect(connect.sock).toBeInstanceOf(net.Socket);
      expect(connect.hostVerifier).toBe("pinned-verifier");
      expect(pinnedKeyVerifier).toHaveBeenCalledWith(
        "pins:org1",
        "127.0.0.1",
        bastionPort,
        expect.any(Object),
      );
      (connect.sock as net.Socket).destroy();
    } finally {
      await new Promise((r) => bastion.close(r));
    }
  });

  it("returns the original string while the tunnel cannot open", async () => {
    pg.queueRows([tunnelConfig("10.0.0.5", 6379)]);
    findTunnel.mockReturnValue(null);
    ensureTunnel.mockRejectedValue(new Error("The SSH tunnel is unavailable (refused)"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const out = await rewriteConnectionForTunnel("acct1", "redis://10.0.0.5:6379");
    expect(out).toBe("redis://10.0.0.5:6379");
    expect(spy.mock.calls[0]).toContain("The SSH tunnel is unavailable (refused)");
  });

  it("swallows resolution errors and returns the original string", async () => {
    pg.queueRows([tunnelConfig("x", 1)]);
    findTunnel.mockImplementation(() => {
      throw new Error("registry exploded");
    });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const out = await rewriteConnectionForTunnel("acct1", "tcp://x:1");
    expect(out).toBe("tcp://x:1");
    expect(spy).toHaveBeenCalled();
  });
});

describe("rewriteCredentialsThroughTunnel", () => {
  const fields = [field("url", "address"), field("host", "address"), field("token")];

  it("is a no-op when no tunnel is configured", async () => {
    findTunnel.mockReturnValue(null);
    // default empty result: no ssh_tunnel_configs row
    const creds = { url: "redis://host:6379", other: "x:1" };
    expect(await rewriteCredentialsThroughTunnel("acct1", fields, creds)).toEqual([]);
    expect(creds).toEqual({ url: "redis://host:6379", other: "x:1" });
  });

  it("does not even look for a tunnel when the plugin marks no field", async () => {
    const creds = { token: "10.0.0.5:6379" };
    expect(await rewriteCredentialsThroughTunnel("acct1", [field("token")], creds)).toEqual([]);
    expect(pg.queries).toHaveLength(0);
  });

  it("rewrites the marked fields that name the tunnel's remote end, and nothing else", async () => {
    pg.queueRows([tunnelConfig("host", 6379)]);
    findTunnel.mockReturnValue({ localPort: 25432, extras: { accountId: "acct1" } });
    const creds = { url: "redis://host:6379", host: "other.internal:6380", token: "host:6379" };
    expect(await rewriteCredentialsThroughTunnel("acct1", fields, creds)).toEqual(["url"]);
    expect(creds).toEqual({
      url: "redis://127.0.0.1:25432",
      host: "other.internal:6380",
      token: "host:6379",
    });
  });

  it("falls back to each marked field's first address when none names the remote end", async () => {
    pg.queueRows([tunnelConfig("10.0.0.5", 6379)]);
    findTunnel.mockReturnValue({ localPort: 25432, extras: { accountId: "acct1" } });
    const creds = { url: "redis://cache.internal:6379", host: "1.2.3.4:6380" };
    await rewriteCredentialsThroughTunnel("acct1", fields, creds);
    expect(creds).toEqual({ url: "redis://127.0.0.1:25432", host: "127.0.0.1:25432" });
  });

  it("gives a peer's credentials no fallback", async () => {
    pg.queueRows([tunnelConfig("10.0.0.5", 6379)]);
    findTunnel.mockReturnValue({ localPort: 25432, extras: { accountId: "acct1" } });
    const creds = { url: "redis://cache.internal:6379" };
    expect(await rewriteCredentialsThroughTunnel("acct1", fields, creds, { peer: true })).toEqual(
      [],
    );
    expect(creds.url).toBe("redis://cache.internal:6379");
  });
});
