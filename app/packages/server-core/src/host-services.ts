/**
 * Builds HostServices for plugin clients on the server side. Mirrors
 * app/packages/desktop/src/lib/sql-drivers.ts but calls node drivers
 * directly instead of going through Electron IPC.
 */
import * as https from "node:https";
import * as http from "node:http";
import { URL } from "node:url";
import { eq, and } from "drizzle-orm";
import type { HostServices, PluginManifest, SecretHostServices } from "@infrawrench/plugin-base";
import { sqlDrivers, kvDrivers, dockerDrivers } from "./drivers";
import { db } from "./db/client";
import { secretFieldStates } from "./db/schema";
import { decrypt, buildAad } from "./encryption";

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
    } catch {
      return null;
    }
  },
};

const httpHostServices: HostServices = {
  http: {
    request: async (req) => {
      if (req.caCert) {
        return nodeHttpsRequest(req);
      }
      const resp = await fetch(req.url, {
        method: req.method,
        headers: req.headers,
        ...(req.body != null ? { body: req.body } : {}),
      });
      return { status: resp.status, body: await resp.text() };
    },
  },
};

function nodeHttpsRequest(req: {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  caCert?: string;
}): Promise<{ status: number; body: string }> {
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
        resolve({
          status: res.statusCode ?? 0,
          body: Buffer.concat(chunks).toString("utf8"),
        });
      });
    });
    clientReq.on("error", reject);
    if (req.body != null) clientReq.write(req.body);
    clientReq.end();
  });
}

/** Inspects the plugin manifest and builds the appropriate HostServices for use with createClient(). */
export function buildPluginHostServices(
  manifest: PluginManifest,
  credentials: Record<string, string>,
): HostServices | undefined {
  const base: HostServices = { ...httpHostServices, secrets: secretHostServices };
  if (manifest.dockerDriver) {
    const dockerHost = credentials[manifest.dockerDriver.credentialKey] ?? "";
    return {
      ...buildDockerHostServices(manifest.dockerDriver.driver, dockerHost),
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
