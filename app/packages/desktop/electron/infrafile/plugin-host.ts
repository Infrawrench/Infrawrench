/**
 * A plugin host built entirely inside the Electron main process.
 *
 * The desktop app builds its workflow host in the *renderer*, reaching main
 * over IPC for credentials and node drivers. The CLI has no renderer, so it
 * needs the same capabilities assembled directly: decrypt from the local
 * SQLite, load the plugin, and call the node drivers in `drivers.ts` rather
 * than posting to the `plugin_*` IPC channels that wrap them.
 *
 * Everything here must stay free of GUI side effects — `electron/index.ts`
 * imports this path only for `--cli`, and importing `plugin-host.ts` (which
 * registers `ipcMain` handlers) from a CLI run would be exactly the kind of
 * cross-contamination the dynamic-import split exists to prevent.
 */
import type {
  HostServices,
  PluginClient,
  PluginManifest,
  SecretHostServices,
} from "@infrawrench/plugin-base" with { "resolution-mode": "import" };

import { dockerDrivers, k8sDrivers, kvDrivers, sqlDrivers } from "../drivers";
import { getSqlite } from "../db";
import { buildAad, decryptValue, getEncryptionKey } from "../main-utils";

/** Decrypt one account's credentials straight out of the local database. */
export async function getAccountCredentials(accountId: string): Promise<Record<string, string>> {
  const db = await getSqlite();
  const stmt = db.prepare(
    "SELECT encrypted_credentials, credentials_iv FROM accounts WHERE id = ? LIMIT 1",
  );
  stmt.bind([accountId]);
  const row = stmt.step() ? (stmt.getAsObject() as Record<string, unknown>) : null;
  stmt.free();
  if (!row) throw new Error(`Account "${accountId}" not found in the local database.`);
  const plaintext = decryptValue(
    String(row["encrypted_credentials"] ?? ""),
    String(row["credentials_iv"] ?? ""),
    getEncryptionKey(),
    buildAad("account", accountId, "credentials"),
  );
  return JSON.parse(plaintext) as Record<string, string>;
}

/**
 * Main-process HTTP for plugins. Unlike the renderer's, this needs no proxying
 * or CORS workarounds — it is a plain Node fetch from the user's own machine.
 */
const httpHostServices = {
  http: {
    async request(req: {
      url: string;
      method: string;
      headers: Record<string, string>;
      body?: string | Uint8Array;
      caCert?: string;
    }): Promise<{ status: number; headers: Record<string, string>; body: string }> {
      // Node's fetch has no per-request CA option, so honouring this would mean
      // a custom undici Agent. Until that exists, say so — silently ignoring it
      // would make a self-signed endpoint fail here with a TLS error while the
      // same account works fine in the app.
      if (req.caCert) {
        throw new Error(
          "A custom CA certificate is not supported from the CLI yet — " +
            "run this against the account from the desktop app or the web app.",
        );
      }
      const res = await fetch(req.url, {
        method: req.method,
        headers: req.headers,
        ...(req.body === undefined ? {} : { body: req.body }),
      });
      const headers: Record<string, string> = {};
      res.headers.forEach((value, key) => {
        headers[key] = value;
      });
      return { status: res.status, headers, body: await res.text() };
    },
  },
};

/**
 * Secret-field lookups against the local `secret_field_states` table. Only
 * `literal` rows carry a value we can decrypt; an output-ref row resolves
 * through the owning plugin instead, so it correctly reads as absent here.
 */
const secretHostServices: SecretHostServices = {
  async getPlaintext(resourceId: string, fieldKey: string): Promise<string | null> {
    try {
      const db = await getSqlite();
      const stmt = db.prepare(
        "SELECT resolution_kind, encrypted_value, value_iv FROM secret_field_states WHERE resource_id = ? AND field_key = ? LIMIT 1",
      );
      stmt.bind([resourceId, fieldKey]);
      const row = stmt.step() ? (stmt.getAsObject() as Record<string, unknown>) : null;
      stmt.free();
      if (!row || row["resolution_kind"] !== "literal") return null;
      const ciphertext = String(row["encrypted_value"] ?? "");
      const iv = String(row["value_iv"] ?? "");
      if (!ciphertext || !iv) return null;
      return decryptValue(
        ciphertext,
        iv,
        getEncryptionKey(),
        buildAad("secret_field", resourceId, fieldKey),
      );
    } catch {
      return null;
    }
  },
  async setPlaintext(): Promise<void> {
    // A deploy reads secrets; it does not mint them. Writes stay in the app,
    // where the create flow that produced the secret can persist it properly.
    throw new Error("Writing secret fields is not supported from the CLI.");
  },
};

/**
 * Build the driver-backed services a plugin's manifest asks for. Mirrors the
 * renderer's `buildPluginHostServices` and server-core's, but calls the node
 * drivers directly instead of hopping through IPC.
 */
function buildHostServices(
  manifest: PluginManifest,
  credentials: Record<string, string>,
): HostServices {
  const base: HostServices = { ...httpHostServices, secrets: secretHostServices };

  if (manifest.dockerDriver) {
    const driver = dockerDrivers.get(manifest.dockerDriver.driver);
    const dockerHost = credentials[manifest.dockerDriver.credentialKey] ?? "";
    if (driver) {
      return {
        ...base,
        docker: {
          command: (op: string, params?: Record<string, unknown>) =>
            driver.command(dockerHost, op, params ?? {}),
        },
      } as HostServices;
    }
  }
  if (manifest.kubernetesDriver) {
    const driver = k8sDrivers.get(manifest.kubernetesDriver.driver);
    const kubeconfig = credentials[manifest.kubernetesDriver.credentialKey] ?? "";
    if (driver) {
      return {
        ...base,
        k8s: {
          command: (op: string, params?: Record<string, unknown>) =>
            driver.command(kubeconfig, op, params ?? {}),
        },
      } as HostServices;
    }
  }
  if (manifest.sqlDriver) {
    const driver = sqlDrivers.get(manifest.sqlDriver.driver);
    const connectionString = credentials[manifest.sqlDriver.credentialKey] ?? "";
    const caCert = manifest.sqlDriver.caCertKey
      ? (credentials[manifest.sqlDriver.caCertKey] ?? "")
      : "";
    const opts = caCert ? { caCert } : undefined;
    if (driver) {
      return {
        ...base,
        sql: {
          query: (sql: string) => driver.query(connectionString, sql, opts),
          execute: (sql: string, params: unknown[] = []) =>
            driver.execute(connectionString, sql, params, opts),
        },
      } as HostServices;
    }
  }
  if (manifest.kvDriver) {
    const driver = kvDrivers.get(manifest.kvDriver.driver);
    const connectionString = credentials[manifest.kvDriver.credentialKey] ?? "";
    if (driver) {
      return {
        ...base,
        kv: {
          command: (command: string, ...args: (string | number)[]) =>
            driver.command(connectionString, command, args),
        },
      } as HostServices;
    }
  }
  return base;
}

/**
 * A ready-to-use plugin client from a credential the caller already holds.
 * This is what makes an ORG account first-class from the CLI: fetch its
 * credentials over the (audited) org API and the plugin runs right here —
 * same listers, same freshness as a local account — instead of reading the
 * cloud's cached rows.
 */
export async function createPluginClientFromCredentials(
  pluginId: string,
  credentials: Record<string, string>,
): Promise<PluginClient> {
  // Imported lazily: the plugin registry is large, and a CLI invocation that
  // never touches a plugin (login, orgs, costs) should not pay to load it.
  const { getPlugin } = await import("./plugins.js");
  const loaded = await getPlugin(pluginId);
  if (!loaded) throw new Error(`Plugin "${pluginId}" is not available.`);
  const services = buildHostServices(loaded.plugin.manifest, credentials);
  return loaded.plugin.createClient(credentials, services);
}

/** A ready-to-use plugin client for one locally-stored account. */
export async function createLocalPluginClient(
  accountId: string,
  pluginId: string,
): Promise<PluginClient> {
  return createPluginClientFromCredentials(pluginId, await getAccountCredentials(accountId));
}
