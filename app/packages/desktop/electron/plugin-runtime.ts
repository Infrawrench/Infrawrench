/**
 * Main-process plugin runtime — loads a plugin, decrypts an account's
 * credentials, and builds `HostServices` by calling the node drivers
 * directly. Anything running inside the Electron main process can therefore
 * enumerate live provider resources without a renderer; the CLI (`--cli`)
 * is the reason this exists.
 *
 * This is the third copy of the same wiring, one per host:
 *   - renderer  → src/lib/sql-drivers.ts    (drivers over IPC)
 *   - web       → server-core/host-services.ts (drivers + bastion dispatch)
 *   - main      → this file                 (drivers directly)
 * Keep them in step when the HostServices contract changes.
 *
 * No GUI side effects — safe to import from electron/cli/*, per the rule in
 * CLAUDE.md that keeps the CLI free of window/IPC dependencies.
 */
import https from "node:https";
import http from "node:http";
import type {
  HostServices,
  HttpHostServices,
  MetricSeries,
  Plugin,
  PluginClient,
  PluginManifest,
  ResourceInstance,
  ResourceTypeDefinition,
  SecretHostServices,
} from "@infrawrench/plugin-base";
import { getPlugin } from "../src/plugins/loader";
import { sqlDrivers, kvDrivers, dockerDrivers, k8sDrivers } from "./drivers";
import { getSqlite, normalizeSql, persist } from "./db";
import {
  buildAad,
  decryptValue,
  encryptValue,
  getEncryptionKey,
  UserFacingError,
} from "./main-utils";

function buildSqlHostServices(
  driverId: string,
  connectionString: string,
  options: { caCert?: string } = {},
): HostServices {
  const driver = sqlDrivers.get(driverId);
  if (!driver) throw new Error(`No SQL driver registered for "${driverId}"`);
  const sqlOptions = options.caCert ? { caCert: options.caCert } : undefined;
  return {
    sql: {
      query: (sql) => driver.query(connectionString, sql, sqlOptions),
      execute: (sql, params) => driver.execute(connectionString, sql, params, sqlOptions),
    },
  };
}

function buildKvHostServices(driverId: string, connectionString: string): HostServices {
  const driver = kvDrivers.get(driverId);
  if (!driver) throw new Error(`No KV driver registered for "${driverId}"`);
  return {
    kv: { command: (cmd, ...args) => driver.command(connectionString, cmd, args) },
  };
}

function buildDockerHostServices(driverId: string, dockerHost: string): HostServices {
  const driver = dockerDrivers.get(driverId);
  if (!driver) throw new Error(`No Docker driver registered for "${driverId}"`);
  return {
    docker: { command: (op, params) => driver.command(dockerHost, op, params) },
  };
}

function buildK8sHostServices(driverId: string, kubeconfig: string): HostServices {
  const driver = k8sDrivers.get(driverId);
  if (!driver) throw new Error(`No Kubernetes driver registered for "${driverId}"`);
  return {
    k8s: { command: (op, params) => driver.command(kubeconfig, op, params) },
  };
}

/**
 * Plain-Node HTTP for plugins. Global `fetch` handles everything except a
 * per-request CA, which only `node:https` can supply.
 *
 * Deliberately not routed through `k8s_api_request`: that channel's SSRF
 * allowlist (electron/k8s-endpoints.ts) exists to stop a *compromised
 * renderer* from reaching private addresses. Callers here already live in
 * the main process, where the URL came from the user's own credential store.
 */
const httpHostServices: HttpHostServices = {
  request: async (req) => {
    if (req.caCert) return nodeHttpsRequest(req);
    const resp = await fetch(req.url, {
      method: req.method,
      headers: req.headers,
      ...(req.body != null ? { body: req.body as string | Uint8Array<ArrayBuffer> } : {}),
    });
    const headers = Object.fromEntries(resp.headers.entries());
    if (req.responseEncoding === "binary") {
      return {
        status: resp.status,
        headers,
        body: "",
        rawBody: new Uint8Array(await resp.arrayBuffer()),
      };
    }
    return {
      status: resp.status,
      headers,
      body: await resp.text(),
    };
  },
};

/** Shared by plugin clients and storage node-drivers in the main process. */
export function getDesktopHttpHostServices(): HttpHostServices {
  return httpHostServices;
}

function nodeHttpsRequest(req: {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string | Uint8Array;
  caCert?: string;
  responseEncoding?: "utf8" | "binary";
}): Promise<{
  status: number;
  headers: Record<string, string>;
  body: string;
  rawBody?: Uint8Array;
}> {
  const parsed = new URL(req.url);
  const isHttps = parsed.protocol === "https:";
  // A custom CA means the caller intended TLS; refuse to silently downgrade.
  if (req.caCert && !isHttps) {
    throw new Error(`Refusing http:// request when a caCert is provided (url=${req.url})`);
  }
  const mod = isHttps ? https : http;
  const options: https.RequestOptions = {
    method: req.method,
    hostname: parsed.hostname,
    port: parsed.port || (isHttps ? 443 : 80),
    path: `${parsed.pathname}${parsed.search}`,
    headers: req.headers,
    ...(isHttps && req.caCert ? { ca: req.caCert } : {}),
  };
  const binary = req.responseEncoding === "binary";
  return new Promise((resolve, reject) => {
    const clientReq = mod.request(options, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(res.headers)) {
          if (v == null) continue;
          headers[k] = Array.isArray(v) ? v.join(", ") : String(v);
        }
        const buf = Buffer.concat(chunks);
        if (binary) {
          resolve({
            status: res.statusCode ?? 0,
            headers,
            body: "",
            rawBody: new Uint8Array(buf),
          });
          return;
        }
        resolve({
          status: res.statusCode ?? 0,
          headers,
          body: buf.toString("utf8"),
        });
      });
    });
    clientReq.on("error", reject);
    clientReq.setTimeout(30_000, () => {
      clientReq.destroy(new Error("Plugin HTTP request timed out (30s)"));
    });
    if (req.body != null) clientReq.write(req.body);
    clientReq.end();
  });
}

/** Mirrors the renderer's `secretHostServices`, decrypting in-process. */
const secretHostServices: SecretHostServices = {
  async getPlaintext(resourceId: string, fieldKey: string): Promise<string | null> {
    try {
      const db = await getSqlite();
      const stmt = db.prepare(
        normalizeSql(
          "SELECT resolution_kind, encrypted_value, value_iv FROM secret_field_states WHERE resource_id = $1 AND field_key = $2 LIMIT 1",
        ),
      );
      stmt.bind([resourceId, fieldKey]);
      const row = stmt.step() ? (stmt.getAsObject() as Record<string, unknown>) : null;
      stmt.free();
      if (!row || row["resolution_kind"] !== "literal") return null;
      const ciphertext = row["encrypted_value"];
      const iv = row["value_iv"];
      if (typeof ciphertext !== "string" || typeof iv !== "string" || !ciphertext || !iv) {
        return null;
      }
      const aad = buildAad("secretField", `${resourceId}:${fieldKey}`, "value");
      return decryptValue(ciphertext, iv, getEncryptionKey(), aad);
    } catch (err) {
      console.error(`[plugin-runtime] getPlaintext(${resourceId}, ${fieldKey}) failed:`, err);
      return null;
    }
  },
  async setPlaintext(resourceId: string, fieldKey: string, value: string): Promise<void> {
    const aad = buildAad("secretField", `${resourceId}:${fieldKey}`, "value");
    const { ciphertext, iv } = encryptValue(value, getEncryptionKey(), aad);
    const db = await getSqlite();
    db.run(
      normalizeSql(
        `INSERT INTO secret_field_states (id, resource_id, field_key, resolution_kind, encrypted_value, value_iv)
         VALUES ($1, $2, $3, 'literal', $4, $5)
         ON CONFLICT(resource_id, field_key) DO UPDATE SET
           resolution_kind = 'literal',
           encrypted_value = excluded.encrypted_value,
           value_iv = excluded.value_iv,
           updated_at = datetime('now')`,
      ),
      [crypto.randomUUID(), resourceId, fieldKey, ciphertext, iv],
    );
    // No-ops when the GUI holds the single-instance lock (see electron/db.ts).
    persist();
  },
};

/** Inspects the manifest and builds the matching HostServices bundle. */
export function buildPluginHostServices(
  manifest: PluginManifest,
  credentials: Record<string, string>,
): HostServices {
  const base: HostServices = { http: httpHostServices, secrets: secretHostServices };
  if (manifest.dockerDriver) {
    const dockerHost = credentials[manifest.dockerDriver.credentialKey] ?? "";
    return { ...buildDockerHostServices(manifest.dockerDriver.driver, dockerHost), ...base };
  }
  if (manifest.kubernetesDriver) {
    const kubeconfig = credentials[manifest.kubernetesDriver.credentialKey] ?? "";
    return { ...buildK8sHostServices(manifest.kubernetesDriver.driver, kubeconfig), ...base };
  }
  if (manifest.sqlDriver) {
    const connectionString = credentials[manifest.sqlDriver.credentialKey] ?? "";
    const caCert = manifest.sqlDriver.caCertKey
      ? (credentials[manifest.sqlDriver.caCertKey] ?? "")
      : "";
    return {
      ...buildSqlHostServices(manifest.sqlDriver.driver, connectionString, {
        ...(caCert ? { caCert } : {}),
      }),
      ...base,
    };
  }
  if (manifest.kvDriver) {
    const connectionString = credentials[manifest.kvDriver.credentialKey] ?? "";
    return { ...buildKvHostServices(manifest.kvDriver.driver, connectionString), ...base };
  }
  return base;
}

interface LocalAccountRow {
  id: string;
  pluginId: string;
  displayName: string;
}

/** Decrypt one local account's credentials. Same AAD as `account_get_credentials`. */
export async function getAccountCredentials(accountId: string): Promise<Record<string, string>> {
  const db = await getSqlite();
  const stmt = db.prepare(
    "SELECT encrypted_credentials, credentials_iv FROM accounts WHERE id = ? LIMIT 1",
  );
  stmt.bind([accountId]);
  const row = stmt.step() ? (stmt.getAsObject() as Record<string, unknown>) : null;
  stmt.free();
  if (!row) throw new UserFacingError(`Account ${accountId} not found in the local workspace.`);
  const plaintext = decryptValue(
    String(row["encrypted_credentials"] ?? ""),
    String(row["credentials_iv"] ?? ""),
    getEncryptionKey(),
    buildAad("account", accountId, "credentials"),
  );
  return JSON.parse(plaintext) as Record<string, string>;
}

/** Load the plugin + decrypted credentials for a local account. */
async function createAccountPluginClient(
  account: LocalAccountRow,
): Promise<{ plugin: Plugin; client: PluginClient }> {
  const loaded = await getPlugin(account.pluginId);
  if (!loaded) throw new UserFacingError(`Plugin "${account.pluginId}" is not available.`);
  const credentials = await getAccountCredentials(account.id);
  const services = buildPluginHostServices(loaded.plugin.manifest, credentials);
  return { plugin: loaded.plugin, client: loaded.plugin.createClient(credentials, services) };
}

/**
 * Resource types worth listing on their own: top-level types plus child types
 * that opted into `showInSidebar`. Duplicated from @infrawrench/ui's
 * `getListableResourceTypes` so the main process doesn't depend on a React
 * package — server-core duplicates it for the same reason.
 */
function listableResourceTypes(types: ResourceTypeDefinition[]): ResourceTypeDefinition[] {
  // An account-root type *is* the account, so it drops out of its own subtree
  // and its direct children take the top level it vacated. Without this the
  // account expands to a single pill for the root while the GUI, which uses
  // `getListableResourceTypes`, expands to the root's contents.
  const root = types.find((t) => t.accountRoot && !t.parentTypeId);
  if (root) {
    return types.filter(
      (t) => t.id !== root.id && (t.parentTypeId === root.id || !t.parentTypeId || t.showInSidebar),
    );
  }
  return types.filter((t) => !t.parentTypeId || t.showInSidebar);
}

export interface LiveResourceListing {
  resources: ResourceInstance[];
  /** Per-type failures. A provider outage on one type shouldn't hide the rest. */
  errors: Array<{ typeId: string; message: string }>;
}

/**
 * Enumerate a local account's resources live from the provider, the way the
 * GUI's sidebar does. The local `resources` table is only a cache of what the
 * app itself created or pinned, so it is not a usable source for listing.
 */
export async function listAccountResourcesLive(
  account: LocalAccountRow,
  options: { typeId?: string } = {},
): Promise<LiveResourceListing> {
  const { plugin, client } = await createAccountPluginClient(account);
  const types = options.typeId
    ? plugin.resourceTypes.filter((t) => t.id === options.typeId)
    : listableResourceTypes(plugin.resourceTypes);
  if (options.typeId && types.length === 0) {
    const known = plugin.resourceTypes.map((t) => t.id).sort();
    throw new UserFacingError(
      `"${account.pluginId}" has no resource type "${options.typeId}". ` +
        `Known types: ${known.join(", ") || "(none)"}.`,
    );
  }

  const settled = await Promise.allSettled(
    types.map((t) => client.listResources(t.id, account.id)),
  );
  const resources: ResourceInstance[] = [];
  const errors: LiveResourceListing["errors"] = [];
  settled.forEach((result, i) => {
    const typeId = types[i]!.id;
    if (result.status === "fulfilled") resources.push(...result.value);
    else {
      const reason: unknown = result.reason;
      errors.push({
        typeId,
        message: reason instanceof Error ? reason.message : String(reason),
      });
    }
  });
  resources.sort(
    (a, b) =>
      a.resourceTypeId.localeCompare(b.resourceTypeId) ||
      a.displayName.localeCompare(b.displayName),
  );
  return { resources, errors };
}

/**
 * Fetch a local resource's metric series live from the provider — the same
 * call the GUI's detail view makes through the renderer. Types that don't
 * declare `supportsMetrics` (or plugins without `fetchMetricSeries`) return
 * an empty list rather than throwing, so callers can render "no metrics"
 * without pre-checking the type definition.
 */
export async function fetchLocalMetricSeries(
  account: LocalAccountRow,
  resourceTypeId: string,
  resourceId: string,
  range?: { startMs: number; endMs: number },
): Promise<MetricSeries[]> {
  const { plugin, client } = await createAccountPluginClient(account);
  const typeDef = plugin.resourceTypes.find((t) => t.id === resourceTypeId);
  if (!typeDef?.supportsMetrics || !client.fetchMetricSeries) return [];
  return client.fetchMetricSeries(resourceTypeId, resourceId, account.id, range);
}

/**
 * Resolve one resource's visible outputs. `listResources` leaves
 * `resolvedOutputs` empty by contract — the host asks for values only when it
 * is about to show them, which is what the detail views do. Sensitive and
 * `hidden` outputs are skipped: nothing should print a secret just because a
 * detail pane was opened.
 */
export async function resolveResourceOutputs(
  account: LocalAccountRow,
  resourceTypeId: string,
  resourceId: string,
): Promise<Record<string, string>> {
  const { plugin, client } = await createAccountPluginClient(account);
  const typeDef = plugin.resourceTypes.find((t) => t.id === resourceTypeId);
  const keys = (typeDef?.outputs ?? []).filter((o) => !o.sensitive && !o.hidden).map((o) => o.key);
  const settled = await Promise.allSettled(
    keys.map((key) => client.resolveOutput(resourceTypeId, resourceId, key, account.id)),
  );
  const outputs: Record<string, string> = {};
  settled.forEach((result, i) => {
    if (result.status === "fulfilled") outputs[keys[i]!] = result.value;
  });
  return outputs;
}
