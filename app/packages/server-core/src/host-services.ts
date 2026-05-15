/**
 * Builds HostServices for plugin clients on the server side. Mirrors
 * app/packages/desktop/src/lib/sql-drivers.ts but calls node drivers
 * directly instead of going through Electron IPC.
 */
import * as https from "node:https";
import * as http from "node:http";
import { URL } from "node:url";
import { eq, and } from "drizzle-orm";
import { fetch as undiciFetch, type RequestInit as UndiciRequestInit } from "undici";
import type {
  HostServices,
  HttpHostServices,
  PluginManifest,
  SecretHostServices,
} from "@infrawrench/plugin-base";
import { sqlDrivers, kvDrivers, dockerDrivers, k8sDrivers } from "./drivers";
import { db } from "./db/client";
import { accounts, secretFieldStates } from "./db/schema";
import { decrypt, buildAad } from "./encryption";
import { getDispatcherFor } from "./bastion/registry";
import { BastionDisconnectedError } from "./bastion/errors";

export function buildHostServices(driverId: string, connectionString: string): HostServices {
  const driver = sqlDrivers.get(driverId);
  if (!driver) throw new Error(`Unknown SQL driver: ${driverId}`);
  return {
    sql: {
      query: (sql) => driver.query(connectionString, sql),
      execute: (sql, params) => driver.execute(connectionString, sql, params),
    },
  };
}

export function buildKvHostServices(driverId: string, connectionString: string): HostServices {
  const driver = kvDrivers.get(driverId);
  if (!driver) throw new Error(`Unknown KV driver: ${driverId}`);
  return {
    kv: {
      command: (cmd, ...args) => driver.command(connectionString, cmd, args),
    },
  };
}

export function buildDockerHostServices(driverId: string, dockerHost: string): HostServices {
  const driver = dockerDrivers.get(driverId);
  if (!driver) throw new Error(`Unknown Docker driver: ${driverId}`);
  return {
    docker: {
      command: (op, params) => driver.command(dockerHost, op, params),
    },
  };
}

export function buildK8sHostServices(driverId: string, kubeconfig: string): HostServices {
  const driver = k8sDrivers.get(driverId);
  if (!driver) throw new Error(`Unknown Kubernetes driver: ${driverId}`);
  return {
    k8s: {
      command: (op, params) => driver.command(kubeconfig, op, params),
    },
  };
}

const secretHostServices: SecretHostServices = {
  async getPlaintext(resourceId: string, fieldKey: string) {
    const [row] = await db
      .select()
      .from(secretFieldStates)
      .where(
        and(eq(secretFieldStates.resourceId, resourceId), eq(secretFieldStates.fieldKey, fieldKey)),
      )
      .limit(1);
    if (!row || row.resolutionKind !== "literal") return null;
    if (!row.encryptedValue || !row.valueIv) return null;
    try {
      return await decrypt(
        row.encryptedValue,
        row.valueIv,
        buildAad("secretField", `${resourceId}:${fieldKey}`, "value"),
      );
    } catch (err) {
      // Log so silent decryption regressions (key rotation, AAD mismatch) are visible.
      console.error(`[host-services] Failed to decrypt secret ${resourceId}:${fieldKey}:`, err);
      return null;
    }
  },
};

/**
 * Build the HTTP host service for a given account. When the account is bound
 * to a connected bastion, plugin HTTPS calls are routed through the agent's
 * dispatcher; when bound but offline, requests throw
 * `BastionDisconnectedError` rather than silently leaking egress.
 *
 * Pass `bastionId = undefined` (the default) for unbound flows (peer-pane
 * resolution from a parent that itself isn't behind a bastion, or callers
 * that genuinely don't have an account context).
 */
function buildHttpHostServices(bastionId: string | null | undefined): HttpHostServices {
  return {
    request: async (req) => {
      if (bastionId) {
        const dispatcher = getDispatcherFor(bastionId);
        if (!dispatcher) throw new BastionDisconnectedError(bastionId);
        // caCert is rarely combined with a bastion (the agent terminates the
        // TCP, but TLS is still client-side). undici uses the OS trust store
        // by default; if a custom CA was supplied, layer it on per-request.
        const init: UndiciRequestInit = {
          method: req.method,
          headers: req.headers,
          dispatcher,
        };
        if (req.body != null) {
          init.body = req.body as UndiciRequestInit["body"];
        }
        const resp = await undiciFetch(req.url, init);
        return {
          status: resp.status,
          headers: Object.fromEntries(resp.headers.entries()),
          body: await resp.text(),
        };
      }
      if (req.caCert) {
        return nodeHttpsRequest(req);
      }
      const resp = await fetch(req.url, {
        method: req.method,
        headers: req.headers,
        ...(req.body != null ? { body: req.body as BodyInit } : {}),
      });
      return {
        status: resp.status,
        headers: Object.fromEntries(resp.headers.entries()),
        body: await resp.text(),
      };
    },
  };
}

function nodeHttpsRequest(req: {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string | Uint8Array;
  caCert?: string;
}): Promise<{ status: number; headers: Record<string, string>; body: string }> {
  const parsed = new URL(req.url);
  const isHttps = parsed.protocol === "https:";
  // A custom CA strongly implies the caller intended TLS. Refuse to silently
  // strip the CA pin and downgrade to plaintext — better to error than to
  // give the caller a false sense of security.
  if (req.caCert && !isHttps) {
    throw new Error(
      `Refusing http:// request when a caCert is provided (url=${req.url}); use https://`,
    );
  }
  const mod = isHttps ? https : http;
  const options: https.RequestOptions = {
    method: req.method ?? "GET",
    hostname: parsed.hostname,
    port: parsed.port || (isHttps ? 443 : 80),
    path: `${parsed.pathname}${parsed.search}`,
    headers: req.headers ?? {},
    ...(isHttps && req.caCert ? { ca: req.caCert } : {}),
  };
  return new Promise((resolve, reject) => {
    const clientReq = mod.request(options, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        const flatHeaders: Record<string, string> = {};
        for (const [k, v] of Object.entries(res.headers)) {
          if (v == null) continue;
          flatHeaders[k] = Array.isArray(v) ? v.join(", ") : String(v);
        }
        resolve({
          status: res.statusCode ?? 0,
          headers: flatHeaders,
          body: Buffer.concat(chunks).toString("utf8"),
        });
      });
    });
    clientReq.on("error", reject);
    if (req.body != null) {
      // node:http accepts string | Buffer | Uint8Array directly.
      clientReq.write(req.body as Buffer | string | Uint8Array);
    }
    clientReq.end();
  });
}

/** Look up an account's bastion binding for the host-services factory. */
async function getAccountBastionId(accountId: string): Promise<string | null> {
  const [row] = await db
    .select({ bastionId: accounts.bastionId })
    .from(accounts)
    .where(eq(accounts.id, accountId))
    .limit(1);
  return row?.bastionId ?? null;
}

/**
 * Inspects the plugin manifest and builds the appropriate HostServices for use with createClient().
 *
 * Pass `accountId` when the credentials come from a stored account row — that
 * lets the HTTP service route through the account's bastion (if any). Callers
 * who already know the bastion id (e.g. peer-pane resolution) can pass
 * `bastionId` directly to skip the DB round-trip.
 */
export async function buildPluginHostServices(
  manifest: PluginManifest,
  credentials: Record<string, string>,
  options: { accountId?: string; bastionId?: string | null } = {},
): Promise<HostServices | undefined> {
  let bastionId: string | null | undefined = options.bastionId;
  if (bastionId === undefined && options.accountId) {
    bastionId = await getAccountBastionId(options.accountId);
  }
  const base: HostServices = {
    http: buildHttpHostServices(bastionId ?? null),
    secrets: secretHostServices,
  };
  if (manifest.dockerDriver) {
    const dockerHost = credentials[manifest.dockerDriver.credentialKey] ?? "";
    return {
      ...buildDockerHostServices(manifest.dockerDriver.driver, dockerHost),
      ...base,
    };
  }
  if (manifest.kubernetesDriver) {
    const kubeconfig = credentials[manifest.kubernetesDriver.credentialKey] ?? "";
    return {
      ...buildK8sHostServices(manifest.kubernetesDriver.driver, kubeconfig),
      ...base,
    };
  }
  if (manifest.sqlDriver) {
    const connectionString = credentials[manifest.sqlDriver.credentialKey] ?? "";
    return {
      ...buildHostServices(manifest.sqlDriver.driver, connectionString),
      ...base,
    };
  }
  if (manifest.kvDriver) {
    const connectionString = credentials[manifest.kvDriver.credentialKey] ?? "";
    return {
      ...buildKvHostServices(manifest.kvDriver.driver, connectionString),
      ...base,
    };
  }
  // Even without a specific driver, provide HTTP proxy for plugins like K8s
  return base;
}
