import { Hono } from "hono";
import { sqlDrivers, kvDrivers, dockerDrivers } from "../../services/drivers";
import {
  sftpList as sftpListImpl,
  sftpMkdir as sftpMkdirImpl,
  sftpDelete as sftpDeleteImpl,
} from "../../services/sftp";
import { rewriteConnectionForTunnel } from "../../services/tunnel-resolver";
import { getClientForAccount, getClientForResource } from "../../services/plugin-clients";
import { resolveSshConfig } from "../../services/ssh";
import { requirePermission } from "../../auth/permissions";
import { logAudit } from "../../services/audit";
import type { AuthSession } from "../auth-middleware";

declare module "hono" {
  interface ContextVariableMap {
    session: AuthSession;
  }
}

const app = new Hono();

/** POST /api/sql/query */
app.post("/sql/query", async (c) => {
  requirePermission(c, "resources:execute");
  const organizationId = c.get("organizationId");
  const input = await c.req.json<{
    accountId: string;
    resourceId?: string;
    resourceTypeId?: string;
    sql: string;
  }>();

  const ctx = await getClientForAccount(input.accountId, organizationId);
  if (!ctx) return c.json({ error: "Account not found" }, 404);
  const { client, plugin, credentials } = ctx;

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
      let connectionString = await client.resolveOutput(
        input.resourceTypeId,
        input.resourceId,
        rtSqlDriver.connectionStringOutputKey,
        input.accountId,
      );
      connectionString = await rewriteConnectionForTunnel(input.accountId, connectionString);
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
    let connectionString = credentials[manifest.sqlDriver.credentialKey] ?? "";
    connectionString = await rewriteConnectionForTunnel(input.accountId, connectionString);
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
  requirePermission(c, "resources:execute");
  const organizationId = c.get("organizationId");
  const session = c.get("session");
  const input = await c.req.json<{
    accountId: string;
    resourceId?: string;
    resourceTypeId?: string;
    sql: string;
    params?: unknown[];
  }>();

  const ctx = await getClientForAccount(input.accountId, organizationId);
  if (!ctx) return c.json({ error: "Account not found" }, 404);
  const { client, plugin, credentials } = ctx;
  const params = input.params ?? [];

  // Audit log every /sql/execute attempt — this is a mutating operation that
  // bypasses the per-resource UI and so should always be traceable to a user.
  // Statement is truncated to 200 chars to bound metadata size and reduce the
  // risk of logging large bind values inline.
  const sqlSnippet = input.sql.slice(0, 200);
  void logAudit({
    organizationId,
    userId: session.userId,
    action: "sql.execute",
    entityType: "account",
    entityId: input.accountId,
    metadata: {
      resourceId: input.resourceId,
      resourceTypeId: input.resourceTypeId,
      sqlSnippet,
    },
  });

  // Per-resource SQL driver
  if (input.resourceId && input.resourceTypeId) {
    const resourceTypeDef = plugin.resourceTypes.find((t) => t.id === input.resourceTypeId);
    const rtSqlDriver = resourceTypeDef?.resourceSqlDriver;
    if (rtSqlDriver) {
      let connectionString = await client.resolveOutput(
        input.resourceTypeId,
        input.resourceId,
        rtSqlDriver.connectionStringOutputKey,
        input.accountId,
      );
      connectionString = await rewriteConnectionForTunnel(input.accountId, connectionString);
      const driver = sqlDrivers.get(rtSqlDriver.driver);
      if (!driver) return c.json({ error: `Unknown SQL driver: ${rtSqlDriver.driver}` }, 400);
      const affectedRows = await driver.execute(connectionString, input.sql, params);
      return c.json({ affectedRows });
    }
  }

  // Account-level SQL driver
  const manifest = plugin.manifest;
  if (manifest.sqlDriver) {
    let connectionString = credentials[manifest.sqlDriver.credentialKey] ?? "";
    connectionString = await rewriteConnectionForTunnel(input.accountId, connectionString);
    const driver = sqlDrivers.get(manifest.sqlDriver.driver);
    if (!driver) return c.json({ error: `Unknown SQL driver: ${manifest.sqlDriver.driver}` }, 400);
    const affectedRows = await driver.execute(connectionString, input.sql, params);
    return c.json({ affectedRows });
  }

  return c.json({ error: "No SQL driver available" }, 400);
});

/** POST /api/sql/estimate — dry-run cost estimation for pay-per-byte backends (e.g. BigQuery). */
app.post("/sql/estimate", async (c) => {
  requirePermission(c, "resources:read");
  const organizationId = c.get("organizationId");
  const input = await c.req.json<{
    accountId: string;
    resourceId: string;
    sql: string;
  }>();

  const ctx = await getClientForAccount(input.accountId, organizationId);
  if (!ctx) return c.json({ error: "Account not found" }, 404);
  const { client } = ctx;
  if (!client.estimateQueryCost) {
    return c.json({ error: "Query cost estimation is not supported for this resource" }, 400);
  }
  const estimate = await client.estimateQueryCost(input.resourceId, input.accountId, input.sql);
  return c.json(estimate);
});

/** POST /api/kv/command */
app.post("/kv/command", async (c) => {
  requirePermission(c, "resources:execute");
  const organizationId = c.get("organizationId");
  const input = await c.req.json<{
    accountId: string;
    command: string;
    args: (string | number)[];
    pluginId?: string;
    parentResourceId?: string;
  }>();

  const ctx = input.pluginId
    ? await getClientForResource(
        input.pluginId,
        input.accountId,
        organizationId,
        input.parentResourceId,
      )
    : await getClientForAccount(input.accountId, organizationId);
  if (!ctx) return c.json({ error: "Account not found" }, 404);
  const { plugin, credentials } = ctx;
  const manifest = plugin.manifest;
  if (!manifest.kvDriver) return c.json({ error: "No KV driver available" }, 400);

  let connectionString = credentials[manifest.kvDriver.credentialKey] ?? "";
  connectionString = await rewriteConnectionForTunnel(input.accountId, connectionString);
  const driver = kvDrivers.get(manifest.kvDriver.driver);
  if (!driver) return c.json({ error: `Unknown KV driver: ${manifest.kvDriver.driver}` }, 400);

  const result = await driver.command(connectionString, input.command, input.args);
  return c.json({ result });
});

/** POST /api/docker/command */
app.post("/docker/command", async (c) => {
  requirePermission(c, "resources:execute");
  const organizationId = c.get("organizationId");
  const input = await c.req.json<{
    accountId: string;
    op: string;
    params?: Record<string, unknown>;
  }>();

  const ctx = await getClientForAccount(input.accountId, organizationId);
  if (!ctx) return c.json({ error: "Account not found" }, 404);
  const { plugin, credentials } = ctx;
  const manifest = plugin.manifest;
  if (!manifest.dockerDriver) return c.json({ error: "No Docker driver available" }, 400);

  let dockerHost = credentials[manifest.dockerDriver.credentialKey] ?? "";
  dockerHost = await rewriteConnectionForTunnel(input.accountId, dockerHost);
  const driver = dockerDrivers.get(manifest.dockerDriver.driver);
  if (!driver)
    return c.json({ error: `Unknown Docker driver: ${manifest.dockerDriver.driver}` }, 400);

  const result = await driver.command(dockerHost, input.op, input.params);
  return c.json({ result });
});

/** POST /api/storage/list */
app.post("/storage/list", async (c) => {
  requirePermission(c, "storage:read");
  const organizationId = c.get("organizationId");
  const input = await c.req.json<{ accountId: string; bucket: string; prefix: string }>();
  const ctx = await getClientForAccount(input.accountId, organizationId);
  if (!ctx) return c.json({ error: "Account not found" }, 404);
  if (!ctx.client.listStorageObjects)
    return c.json({ error: "Plugin does not support storage listing" }, 400);
  const result = await ctx.client.listStorageObjects(input.bucket, input.prefix);
  return c.json(result);
});

/** POST /api/storage/mkdir */
app.post("/storage/mkdir", async (c) => {
  requirePermission(c, "storage:write");
  const organizationId = c.get("organizationId");
  const input = await c.req.json<{ accountId: string; bucket: string; key: string }>();
  const ctx = await getClientForAccount(input.accountId, organizationId);
  if (!ctx) return c.json({ error: "Account not found" }, 404);
  if (!ctx.client.makeStorageFolder)
    return c.json({ error: "Plugin does not support folder creation" }, 400);
  await ctx.client.makeStorageFolder(input.bucket, input.key);
  return c.json({ ok: true });
});

/** POST /api/storage/delete */
app.post("/storage/delete", async (c) => {
  requirePermission(c, "storage:write");
  const organizationId = c.get("organizationId");
  const input = await c.req.json<{ accountId: string; bucket: string; key: string }>();
  const ctx = await getClientForAccount(input.accountId, organizationId);
  if (!ctx) return c.json({ error: "Account not found" }, 404);
  if (!ctx.client.deleteStorageObject)
    return c.json({ error: "Plugin does not support object deletion" }, 400);
  await ctx.client.deleteStorageObject(input.bucket, input.key);
  return c.json({ ok: true });
});

/** POST /api/artifacts/list */
app.post("/artifacts/list", async (c) => {
  requirePermission(c, "storage:read");
  const organizationId = c.get("organizationId");
  const input = await c.req.json<{
    accountId: string;
    resourceId: string;
    resourceTypeId: string;
    pageToken?: string;
    prefix?: string;
  }>();

  try {
    const ctx = await getClientForAccount(input.accountId, organizationId);
    if (!ctx) return c.json({ error: "Account not found" }, 404);
    if (!ctx.client.listArtifacts)
      return c.json({ error: "Plugin does not support artifact listing" }, 400);

    const params: { pageToken?: string; prefix?: string } = {};
    if (input.pageToken) params.pageToken = input.pageToken;
    if (input.prefix) params.prefix = input.prefix;

    const result = await ctx.client.listArtifacts(
      input.resourceTypeId,
      input.resourceId,
      input.accountId,
      params,
    );
    return c.json(result);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : "Artifact list failed" }, 500);
  }
});

/** POST /api/sftp/list */
app.post("/sftp/list", async (c) => {
  requirePermission(c, "storage:read");
  const organizationId = c.get("organizationId");
  const input = await c.req.json<{
    accountId: string;
    path: string;
    sshKeyId?: string;
    sshHost?: string;
    sshUsername?: string;
  }>();
  try {
    const ctx = await getClientForAccount(input.accountId, organizationId);
    if (!ctx) return c.json({ error: "Account not found" }, 404);
    const config = await resolveSshConfig(ctx.client, organizationId, input);
    const result = await sftpListImpl(organizationId, config, input.path);
    return c.json(result);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : "SFTP list failed" }, 500);
  }
});

/** POST /api/sftp/mkdir */
app.post("/sftp/mkdir", async (c) => {
  requirePermission(c, "storage:write");
  const organizationId = c.get("organizationId");
  const input = await c.req.json<{
    accountId: string;
    path: string;
    sshKeyId?: string;
    sshHost?: string;
    sshUsername?: string;
  }>();
  try {
    const ctx = await getClientForAccount(input.accountId, organizationId);
    if (!ctx) return c.json({ error: "Account not found" }, 404);
    const config = await resolveSshConfig(ctx.client, organizationId, input);
    await sftpMkdirImpl(organizationId, config, input.path);
    return c.json({ ok: true });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : "SFTP mkdir failed" }, 500);
  }
});

/** POST /api/sftp/delete */
app.post("/sftp/delete", async (c) => {
  requirePermission(c, "storage:write");
  const organizationId = c.get("organizationId");
  const input = await c.req.json<{
    accountId: string;
    path: string;
    isDir: boolean;
    sshKeyId?: string;
    sshHost?: string;
    sshUsername?: string;
  }>();
  try {
    const ctx = await getClientForAccount(input.accountId, organizationId);
    if (!ctx) return c.json({ error: "Account not found" }, 404);
    const config = await resolveSshConfig(ctx.client, organizationId, input);
    await sftpDeleteImpl(organizationId, config, input.path, input.isDir);
    return c.json({ ok: true });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : "SFTP delete failed" }, 500);
  }
});

export { app as connectionFeatureRoutes };
