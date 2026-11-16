/**
 * A local account made with "Connect to service via SSH" connects through its
 * tunnel (#1272): each driver kind the modal offers, with the credentials the
 * modal stores and its plugin's real `tunnel` declarations, is pointed at the
 * tunnel's local end, opening the tunnel from `ssh_tunnel_configs` when it is
 * not open. The database and the SSH layer are stand-ins.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginManifest } from "@infrawrench/plugin-base";
import { plugin as docker } from "@infrawrench/plugin-docker";
import { plugin as memcached } from "@infrawrench/plugin-memcached";
import { plugin as mysql } from "@infrawrench/plugin-mysql";
import { plugin as postgres } from "@infrawrench/plugin-postgres";
import { plugin as redis } from "@infrawrench/plugin-redis";

interface ConfigRow {
  id: string;
  ssh_host: string;
  ssh_port: number;
  ssh_user: string;
  remote_host: string;
  remote_port: number;
  encrypted_private_key: string;
  private_key_iv: string;
}

const h = vi.hoisted(() => ({
  rows: new Map<string, ConfigRow>(),
  queries: 0,
  open: new Map<string, number>(),
  nextPort: 41000,
  openTunnel: vi.fn(),
  pending: new Map<string, Promise<unknown>>(),
}));

vi.mock("../db", () => ({
  getSqlite: async () => ({
    prepare: () => {
      let accountId = "";
      let done = false;
      return {
        bind: ([id]: string[]) => {
          accountId = id ?? "";
          h.queries += 1;
        },
        step: () => {
          if (done || !h.rows.has(accountId)) return false;
          done = true;
          return true;
        },
        getAsObject: () => ({ ...h.rows.get(accountId) }),
        free: () => undefined,
      };
    },
  }),
}));

vi.mock("../main-utils", () => ({
  buildAad: (...parts: string[]) => parts.join("|"),
  getEncryptionKey: () => "master-key",
  decryptValue: (ciphertext: string, _iv: string, _key: string, aad: string) =>
    `decrypted(${ciphertext}, ${aad})`,
}));

// `ensureAccountTunnel` stands in for `@infrawrench/ssh-tunnel-core`'s `ensureTunnel`:
// one open per account at a time, the config read only when it opens. Reopening
// after a drop and waiting between failures are the core's, tested there.
vi.mock("../ssh-tunnel", () => ({
  findAccountTunnel: (accountId: string) => h.open.get(accountId) ?? null,
  ensureAccountTunnel: (accountId: string, config: () => unknown) => {
    const pending = h.pending.get(accountId);
    if (pending) return pending;
    const started = Promise.resolve()
      .then(() => h.openTunnel(config(), { accountId }))
      .finally(() => h.pending.delete(accountId));
    h.pending.set(accountId, started);
    return started;
  },
}));

const { tunnelAccountCredentials } = await import("../account-tunnels");

beforeEach(() => {
  h.rows.clear();
  h.open.clear();
  h.pending.clear();
  h.queries = 0;
  h.nextPort = 41000;
  h.openTunnel.mockReset();
  h.openTunnel.mockImplementation(
    async (_config: unknown, { accountId }: { accountId: string }) => {
      await new Promise((r) => setTimeout(r, 5));
      const localPort = h.nextPort++;
      h.open.set(accountId, localPort);
      return { tunnelId: `t${localPort}`, localPort };
    },
  );
});

/** The row and credentials the "Connect to service via SSH" modal stores for `manifest`. */
function connectViaSsh(accountId: string, manifest: PluginManifest) {
  const preset = manifest.sshTunnel!;
  const port = preset.defaultPort;
  h.rows.set(accountId, {
    id: `cfg-${accountId}`,
    ssh_host: "bastion.example.com",
    ssh_port: 22,
    ssh_user: "ubuntu",
    remote_host: "127.0.0.1",
    remote_port: port,
    encrypted_private_key: "ciphertext",
    private_key_iv: "iv",
  });
  return Object.fromEntries(
    Object.entries(preset.credentials).map(([k, v]) => [k, v.replaceAll("{port}", String(port))]),
  );
}

describe("tunnelAccountCredentials", () => {
  it.each([
    ["postgres", postgres.manifest, { connectionString: "postgresql://127.0.0.1:41000/postgres" }],
    ["mysql", mysql.manifest, { connectionString: "mysql://127.0.0.1:41000/mysql" }],
    ["redis", redis.manifest, { connectionString: "redis://127.0.0.1:41000" }],
    ["memcached", memcached.manifest, { connectionString: "memcached://127.0.0.1:41000" }],
    ["docker", docker.manifest, { dockerHost: "tcp://127.0.0.1:41000" }],
  ])(
    "points a %s account at a tunnel it opens from the stored config",
    async (_, manifest, want) => {
      const credentials = connectViaSsh("acc", manifest);
      const changed = await tunnelAccountCredentials("acc", manifest.credentialFields, credentials);

      expect(credentials).toEqual(want);
      expect(changed).toEqual(Object.keys(want));
      expect(h.openTunnel).toHaveBeenCalledTimes(1);
      expect(h.openTunnel).toHaveBeenCalledWith(
        {
          sshHost: "bastion.example.com",
          sshPort: 22,
          sshUser: "ubuntu",
          privateKey: "decrypted(ciphertext, sshTunnelConfig|cfg-acc|privateKey)",
          remoteHost: "127.0.0.1",
          remotePort: manifest.sshTunnel!.defaultPort,
        },
        { accountId: "acc" },
      );
    },
  );

  it("uses a tunnel that is already open, and keeps every other field", async () => {
    const credentials: Record<string, string> = {
      ...connectViaSsh("acc", postgres.manifest),
      caCert: "-----BEGIN CERTIFICATE-----\nlocalhost:5432\n-----END CERTIFICATE-----",
    };
    h.open.set("acc", 45555);
    await tunnelAccountCredentials("acc", postgres.manifest.credentialFields, credentials);

    expect(credentials["connectionString"]).toBe("postgresql://127.0.0.1:45555/postgres");
    expect(credentials["caCert"]).toContain("localhost:5432");
    expect(h.openTunnel).not.toHaveBeenCalled();
  });

  it("keeps a URL's user, password, path and query", async () => {
    connectViaSsh("acc", postgres.manifest);
    const credentials = {
      connectionString: "postgresql://app:p%40ss@localhost:5432/orders?sslmode=disable",
    };
    await tunnelAccountCredentials("acc", postgres.manifest.credentialFields, credentials);
    expect(credentials.connectionString).toBe(
      "postgresql://app:p%40ss@127.0.0.1:41000/orders?sslmode=disable",
    );
  });

  it("leaves an account with no tunnel config alone", async () => {
    const credentials = { connectionString: "postgresql://db.internal:5432/app" };
    const changed = await tunnelAccountCredentials(
      "plain",
      postgres.manifest.credentialFields,
      credentials,
    );
    expect(changed).toEqual([]);
    expect(credentials.connectionString).toBe("postgresql://db.internal:5432/app");
    expect(h.openTunnel).not.toHaveBeenCalled();
  });

  it("does not read the database for a plugin that marks no field", async () => {
    const credentials = { token: "secret" };
    await tunnelAccountCredentials("acc", [{ key: "token" }], credentials);
    expect(h.queries).toBe(0);
    expect(credentials).toEqual({ token: "secret" });
  });

  it("opens one tunnel for clients that ask at the same time", async () => {
    const a = connectViaSsh("acc", redis.manifest);
    const b = { ...a };
    await Promise.all([
      tunnelAccountCredentials("acc", redis.manifest.credentialFields, a),
      tunnelAccountCredentials("acc", redis.manifest.credentialFields, b),
    ]);
    expect(h.openTunnel).toHaveBeenCalledTimes(1);
    expect(a).toEqual(b);
    expect(a["connectionString"]).toBe("redis://127.0.0.1:41000");
  });

  it("fails rather than connect to this computer's own port when the tunnel cannot open", async () => {
    const credentials = connectViaSsh("acc", mysql.manifest);
    h.openTunnel.mockRejectedValueOnce(new Error("SSH connection failed: connect ECONNREFUSED"));
    await expect(
      tunnelAccountCredentials("acc", mysql.manifest.credentialFields, credentials),
    ).rejects.toThrow(
      "Could not open the SSH tunnel through bastion.example.com: SSH connection failed: connect ECONNREFUSED",
    );
    // A failed open is not handed to the next caller.
    await tunnelAccountCredentials("acc", mysql.manifest.credentialFields, credentials);
    expect(credentials["connectionString"]).toBe("mysql://127.0.0.1:41000/mysql");
  });

  it("rewrites a peer's address only when it names the tunnel's remote end", async () => {
    connectViaSsh("acc", postgres.manifest);
    const elsewhere = { connectionString: "postgresql://db.internal:5432/app" };
    await tunnelAccountCredentials("acc", postgres.manifest.credentialFields, elsewhere, {
      peer: true,
    });
    expect(elsewhere.connectionString).toBe("postgresql://db.internal:5432/app");

    const named = { connectionString: "postgresql://localhost:5432/app" };
    await tunnelAccountCredentials("acc", postgres.manifest.credentialFields, named, {
      peer: true,
    });
    expect(named.connectionString).toBe("postgresql://127.0.0.1:41000/app");
  });
});
