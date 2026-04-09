import { Hono } from "hono";
import { eq, and } from "drizzle-orm";
import { db } from "../../db/client";
import { accounts } from "../../db/schema";
import { decrypt } from "../../services/encryption";
import { getPlugin } from "../../plugins/loader";
import { buildPluginHostServices } from "../../services/host-services";
import { sqlDrivers, kvDrivers, dockerDrivers } from "../../services/drivers";
import {
  sftpList as sftpListImpl,
  sftpMkdir as sftpMkdirImpl,
  sftpDelete as sftpDeleteImpl,
} from "../../services/sftp";
import type { AuthSession } from "../auth-middleware";

declare module "hono" {
  interface ContextVariableMap {
    session: AuthSession;
  }
}

const app = new Hono();

async function getClientForAccount(accountId: string, organizationId: string) {
  const [account] = await db
    .select({
      id: accounts.id,
      pluginId: accounts.pluginId,
      encryptedCredentials: accounts.encryptedCredentials,
      credentialsIv: accounts.credentialsIv,
    })
    .from(accounts)
    .where(and(eq(accounts.id, accountId), eq(accounts.organizationId, organizationId)))
    .limit(1);

  if (!account) throw new Error("Account not found");

  const plaintext = await decrypt(account.encryptedCredentials, account.credentialsIv);
  const credentials = JSON.parse(plaintext) as Record<string, string>;

  const loaded = await getPlugin(account.pluginId);
  if (!loaded) throw new Error(`Plugin "${account.pluginId}" not loaded`);

  const hostServices = buildPluginHostServices(loaded.plugin.manifest, credentials);
  const client = loaded.plugin.createClient(credentials, hostServices);
  return { client, plugin: loaded.plugin, credentials, account };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getSshConfig(client: any): { host: string; port: number; username: string; privateKey: string } {
  const config = client.getSshConfig?.();
  if (!config) throw new Error("Plugin does not support SSH");
  return config;
}

// ── SQL ─────────────────────────────────────────────────────────────────────

/** POST /api/sql/query */
app.post("/sql/query", async (c) => {
  const { organizationId } = c.get("session");
  const input = await c.req.json<{
    accountId: string;
    resourceId?: string;
    resourceTypeId?: string;
    sql: string;
  }>();

  const { client, plugin, credentials } = await getClientForAccount(input.accountId, organizationId);

  // REST-based query (e.g. BigQuery, Databricks)
  if (input.resourceId && client.executeQuery) {
    const result = await client.executeQuery(input.resourceId, input.accountId, input.sql);
    return c.json(result);
  }

  // Per-resource SQL driver (e.g. Neon database, Turso database)
  if (input.resourceId && input.resourceTypeId) {
    const resourceTypeDef = plugin.resourceTypes.find((t) => t.id === input.resourceTypeId);
    const rtSqlDriver = resourceTypeDef?.resourceSqlDriver;
    if (rtSqlDriver) {
      const connectionString = await client.resolveOutput(
        input.resourceTypeId,
        input.resourceId,
        rtSqlDriver.connectionStringOutputKey,
        input.accountId,
      );
      const driver = sqlDrivers.get(rtSqlDriver.driver);
      if (!driver) return c.json({ error: `Unknown SQL driver: ${rtSqlDriver.driver}` }, 400);
      const start = Date.now();
      const rows = await driver.query(connectionString, input.sql);
      return c.json({ rows, durationMs: Date.now() - start });
    }
  }

  // Account-level SQL driver (e.g. Postgres, MySQL)
  const manifest = plugin.manifest;
  if (manifest.sqlDriver) {
    const connectionString = credentials[manifest.sqlDriver.credentialKey] ?? "";
    const driver = sqlDrivers.get(manifest.sqlDriver.driver);
    if (!driver) return c.json({ error: `Unknown SQL driver: ${manifest.sqlDriver.driver}` }, 400);
    const start = Date.now();
    const rows = await driver.query(connectionString, input.sql);
    return c.json({ rows, durationMs: Date.now() - start });
  }

  return c.json({ error: "No SQL driver available" }, 400);
});

/** POST /api/sql/execute */
app.post("/sql/execute", async (c) => {
  const { organizationId } = c.get("session");
  const input = await c.req.json<{
    accountId: string;
    resourceId?: string;
    resourceTypeId?: string;
    sql: string;
    params?: unknown[];
  }>();

  const { client, plugin, credentials } = await getClientForAccount(input.accountId, organizationId);
  const params = input.params ?? [];

  // Per-resource SQL driver
  if (input.resourceId && input.resourceTypeId) {
    const resourceTypeDef = plugin.resourceTypes.find((t) => t.id === input.resourceTypeId);
    const rtSqlDriver = resourceTypeDef?.resourceSqlDriver;
    if (rtSqlDriver) {
      const connectionString = await client.resolveOutput(
        input.resourceTypeId,
        input.resourceId,
        rtSqlDriver.connectionStringOutputKey,
        input.accountId,
      );
      const driver = sqlDrivers.get(rtSqlDriver.driver);
      if (!driver) return c.json({ error: `Unknown SQL driver: ${rtSqlDriver.driver}` }, 400);
      const affectedRows = await driver.execute(connectionString, input.sql, params);
      return c.json({ affectedRows });
    }
  }

  // Account-level SQL driver
  const manifest = plugin.manifest;
  if (manifest.sqlDriver) {
    const connectionString = credentials[manifest.sqlDriver.credentialKey] ?? "";
    const driver = sqlDrivers.get(manifest.sqlDriver.driver);
    if (!driver) return c.json({ error: `Unknown SQL driver: ${manifest.sqlDriver.driver}` }, 400);
    const affectedRows = await driver.execute(connectionString, input.sql, params);
    return c.json({ affectedRows });
  }

  return c.json({ error: "No SQL driver available" }, 400);
});

// ── KV ──────────────────────────────────────────────────────────────────────

/** POST /api/kv/command */
app.post("/kv/command", async (c) => {
  const { organizationId } = c.get("session");
  const input = await c.req.json<{
    accountId: string;
    command: string;
    args: (string | number)[];
  }>();

  const { plugin, credentials } = await getClientForAccount(input.accountId, organizationId);
  const manifest = plugin.manifest;
  if (!manifest.kvDriver) return c.json({ error: "No KV driver available" }, 400);

  const connectionString = credentials[manifest.kvDriver.credentialKey] ?? "";
  const driver = kvDrivers.get(manifest.kvDriver.driver);
  if (!driver) return c.json({ error: `Unknown KV driver: ${manifest.kvDriver.driver}` }, 400);

  const result = await driver.command(connectionString, input.command, input.args);
  return c.json({ result });
});

// ── Docker ──────────────────────────────────────────────────────────────────

/** POST /api/docker/command */
app.post("/docker/command", async (c) => {
  const { organizationId } = c.get("session");
  const input = await c.req.json<{
    accountId: string;
    op: string;
    params?: Record<string, unknown>;
  }>();

  const { plugin, credentials } = await getClientForAccount(input.accountId, organizationId);
  const manifest = plugin.manifest;
  if (!manifest.dockerDriver) return c.json({ error: "No Docker driver available" }, 400);

  const dockerHost = credentials[manifest.dockerDriver.credentialKey] ?? "";
  const driver = dockerDrivers.get(manifest.dockerDriver.driver);
  if (!driver) return c.json({ error: `Unknown Docker driver: ${manifest.dockerDriver.driver}` }, 400);

  const result = await driver.command(dockerHost, input.op, input.params);
  return c.json({ result });
});

// ── Storage ─────────────────────────────────────────────────────────────────

/** POST /api/storage/list */
app.post("/storage/list", async (c) => {
  const { organizationId } = c.get("session");
  const input = await c.req.json<{ accountId: string; bucket: string; prefix: string }>();
  const { client } = await getClientForAccount(input.accountId, organizationId);
  if (!client.listStorageObjects) return c.json({ error: "Plugin does not support storage listing" }, 400);
  const result = await client.listStorageObjects(input.bucket, input.prefix);
  return c.json(result);
});

/** POST /api/storage/mkdir */
app.post("/storage/mkdir", async (c) => {
  const { organizationId } = c.get("session");
  const input = await c.req.json<{ accountId: string; bucket: string; key: string }>();
  const { client } = await getClientForAccount(input.accountId, organizationId);
  if (!client.makeStorageFolder) return c.json({ error: "Plugin does not support folder creation" }, 400);
  await client.makeStorageFolder(input.bucket, input.key);
  return c.json({ ok: true });
});

/** POST /api/storage/delete */
app.post("/storage/delete", async (c) => {
  const { organizationId } = c.get("session");
  const input = await c.req.json<{ accountId: string; bucket: string; key: string }>();
  const { client } = await getClientForAccount(input.accountId, organizationId);
  if (!client.deleteStorageObject) return c.json({ error: "Plugin does not support object deletion" }, 400);
  await client.deleteStorageObject(input.bucket, input.key);
  return c.json({ ok: true });
});

/** POST /api/storage/stats */
app.post("/storage/stats", async (c) => {
  const { organizationId } = c.get("session");
  const input = await c.req.json<{ accountId: string; bucket: string }>();
  const { client } = await getClientForAccount(input.accountId, organizationId);
  if (!client.fetchStorageStats) return c.json({ error: "Plugin does not support storage stats" }, 400);
  const result = await client.fetchStorageStats(input.bucket);
  return c.json(result);
});

// ── SFTP ────────────────────────────────────────────────────────────────────

/** POST /api/sftp/list */
app.post("/sftp/list", async (c) => {
  const { organizationId } = c.get("session");
  const input = await c.req.json<{ accountId: string; path: string }>();
  const { client } = await getClientForAccount(input.accountId, organizationId);
  const config = getSshConfig(client);
  const result = await sftpListImpl(config, input.path);
  return c.json(result);
});

/** POST /api/sftp/mkdir */
app.post("/sftp/mkdir", async (c) => {
  const { organizationId } = c.get("session");
  const input = await c.req.json<{ accountId: string; path: string }>();
  const { client } = await getClientForAccount(input.accountId, organizationId);
  const config = getSshConfig(client);
  await sftpMkdirImpl(config, input.path);
  return c.json({ ok: true });
});

/** POST /api/sftp/delete */
app.post("/sftp/delete", async (c) => {
  const { organizationId } = c.get("session");
  const input = await c.req.json<{ accountId: string; path: string; isDir: boolean }>();
  const { client } = await getClientForAccount(input.accountId, organizationId);
  const config = getSshConfig(client);
  await sftpDeleteImpl(config, input.path, input.isDir);
  return c.json({ ok: true });
});

export { app as connectionFeatureRoutes };
