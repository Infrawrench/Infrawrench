import { invoke } from "../lib/invoke";
import { getDb } from "../db/client";
import type { HostServices, PluginManifest, SecretHostServices } from "@infrawrench/plugin-base";

export function sqlQuery(
  driverId: string,
  connectionString: string,
  sql: string,
  options?: { caCert?: string },
): Promise<Record<string, unknown>[]> {
  return invoke<Record<string, unknown>[]>("plugin_sql_query", {
    driverId,
    connectionString,
    sql,
    ...(options?.caCert ? { caCert: options.caCert } : {}),
  });
}

export function sqlExecute(
  driverId: string,
  connectionString: string,
  sql: string,
  params: unknown[],
  options?: { caCert?: string },
): Promise<number> {
  return invoke<number>("plugin_sql_execute", {
    driverId,
    connectionString,
    sql,
    params,
    ...(options?.caCert ? { caCert: options.caCert } : {}),
  });
}

export function buildHostServices(
  driverId: string,
  connectionString: string,
  options: { caCert?: string } = {},
): HostServices {
  const sqlOpts = options.caCert ? { caCert: options.caCert } : undefined;
  return {
    sql: {
      query: (sql) => sqlQuery(driverId, connectionString, sql, sqlOpts),
      execute: (sql, params) => sqlExecute(driverId, connectionString, sql, params, sqlOpts),
    },
  };
}

export function kvCommand(
  driverId: string,
  connectionString: string,
  command: string,
  ...args: (string | number)[]
): Promise<unknown> {
  return invoke<unknown>("plugin_kv_command", { driverId, connectionString, command, args });
}

export function buildKvHostServices(driverId: string, connectionString: string): HostServices {
  return {
    kv: {
      command: (cmd, ...args) => kvCommand(driverId, connectionString, cmd, ...args),
    },
  };
}

// memcached routes through the same plugin_kv_command channel with driverId="memcached"
export const buildMemcachedHostServices = buildKvHostServices;

export function dockerCommand(
  driverId: string,
  dockerHost: string,
  op: string,
  params?: Record<string, unknown>,
): Promise<unknown> {
  return invoke<unknown>("plugin_docker_command", { driverId, dockerHost, op, params });
}

export function buildDockerHostServices(driverId: string, dockerHost: string): HostServices {
  return {
    docker: {
      command: (op, params) => dockerCommand(driverId, dockerHost, op, params),
    },
  };
}

function k8sCommand(
  driverId: string,
  kubeconfig: string,
  op: string,
  params?: Record<string, unknown>,
): Promise<unknown> {
  return invoke<unknown>("plugin_k8s_command", { driverId, kubeconfig, op, params });
}

function buildK8sHostServices(driverId: string, kubeconfig: string): HostServices {
  return {
    k8s: {
      command: (op, params) => k8sCommand(driverId, kubeconfig, op, params),
    },
  };
}

function httpRequest(req: {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string | Uint8Array;
  caCert?: string;
}): Promise<{ status: number; headers: Record<string, string>; body: string }> {
  return invoke<{ status: number; headers: Record<string, string>; body: string }>(
    "k8s_api_request",
    req,
  );
}

const httpHostServices = { http: { request: httpRequest } };

/**
 * Renderer-side `SecretHostServices` — looks up persisted secret-field rows
 * via the SQLite IPC and decrypts them through the main process. Mirrors
 * `app/packages/server-core/src/host-services.ts` so plugin code that calls
 * `ctx.hostServices.secrets.getPlaintext(resourceId, fieldKey)` works the
 * same way on desktop and web.
 */
const secretHostServices: SecretHostServices = {
  async getPlaintext(resourceId: string, fieldKey: string): Promise<string | null> {
    try {
      const db = await getDb();
      const rows = await db.select<
        Array<{
          resolution_kind: string;
          encrypted_value: string | null;
          value_iv: string | null;
        }>
      >(
        "SELECT resolution_kind, encrypted_value, value_iv FROM secret_field_states WHERE resource_id = $1 AND field_key = $2 LIMIT 1",
        [resourceId, fieldKey],
      );
      const row = rows[0];
      if (!row || row.resolution_kind !== "literal") return null;
      if (!row.encrypted_value || !row.value_iv) return null;
      const plaintext = await invoke<string>("secret_field_decrypt", {
        resourceId,
        fieldKey,
        ciphertext: row.encrypted_value,
        iv: row.value_iv,
      });
      return plaintext;
    } catch (err) {
      console.error(`[secrets] getPlaintext(${resourceId}, ${fieldKey}) failed:`, err);
      return null;
    }
  },
};

/**
 * Persist a plaintext secret returned by a plugin's `createResource` (or any
 * other flow that yields plaintext). Mirrors what the web server does inline
 * after create — encrypts via the main process, then upserts into the
 * `secret_field_states` table the renderer can read back via
 * `secretHostServices.getPlaintext`.
 */
export async function persistPlaintextSecret(
  resourceId: string,
  fieldKey: string,
  plaintext: string,
): Promise<void> {
  const { ciphertext, iv } = await invoke<{ ciphertext: string; iv: string }>(
    "secret_field_encrypt",
    { resourceId, fieldKey, plaintext },
  );
  const db = await getDb();
  await db.execute(
    `INSERT INTO secret_field_states (id, resource_id, field_key, resolution_kind, encrypted_value, value_iv)
     VALUES ($1, $2, $3, 'literal', $4, $5)
     ON CONFLICT(resource_id, field_key) DO UPDATE SET
       resolution_kind = 'literal',
       encrypted_value = excluded.encrypted_value,
       value_iv = excluded.value_iv,
       source_plugin_id = NULL,
       source_resource_type_id = NULL,
       source_resource_id = NULL,
       source_account_id = NULL,
       source_output_key = NULL,
       cached_encrypted_value = NULL,
       cached_value_iv = NULL,
       cached_at = NULL,
       updated_at = datetime('now')`,
    [crypto.randomUUID(), resourceId, fieldKey, ciphertext, iv],
  );
}

/** Inspects the plugin manifest and builds the appropriate HostServices for use with createClient(). */
export function buildPluginHostServices(
  manifest: PluginManifest,
  credentials: Record<string, string>,
): HostServices | undefined {
  // `secrets` is added to every host-services bundle so any plugin (driver
  // or HTTP-only) can resolve persisted secret-field values via the same
  // IPC-backed lookup. Mirrors the server-core `buildPluginHostServices`.
  const base: HostServices = { ...httpHostServices, secrets: secretHostServices };
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
      ...buildHostServices(manifest.sqlDriver.driver, connectionString, {
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
