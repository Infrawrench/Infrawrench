"use server";

import { eq, and } from "drizzle-orm";
import { db } from "@/db/client";
import { accounts } from "@/db/schema";
import { decrypt } from "@/services/encryption";
import { requireAuth } from "@/auth/session";
import { getPlugin } from "@/plugins/loader";
import { buildPluginHostServices } from "@/services/host-services";
import { sqlDrivers, kvDrivers, dockerDrivers } from "@/services/drivers";
import {
  sftpList as sftpListImpl,
  sftpMkdir as sftpMkdirImpl,
  sftpDelete as sftpDeleteImpl,
  type SftpEntry,
} from "@/services/sftp";

async function getClientForAccount(accountId: string) {
  const { organizationId } = await requireAuth();

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

// ── SQL ─────────────────────────────────────────────────────────────────────

export async function sqlQuery(input: {
  accountId: string;
  resourceId?: string;
  resourceTypeId?: string;
  sql: string;
}): Promise<{ rows: Record<string, unknown>[]; durationMs: number }> {
  const { client, plugin, credentials } = await getClientForAccount(input.accountId);

  // REST-based query (e.g. BigQuery, Databricks) — executeQuery on the client
  if (input.resourceId && client.executeQuery) {
    return client.executeQuery(input.resourceId, input.accountId, input.sql);
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
      if (!driver) throw new Error(`Unknown SQL driver: ${rtSqlDriver.driver}`);
      const start = Date.now();
      const rows = await driver.query(connectionString, input.sql);
      return { rows, durationMs: Date.now() - start };
    }
  }

  // Account-level SQL driver (e.g. Postgres, MySQL)
  const manifest = plugin.manifest;
  if (manifest.sqlDriver) {
    const connectionString = credentials[manifest.sqlDriver.credentialKey] ?? "";
    const driver = sqlDrivers.get(manifest.sqlDriver.driver);
    if (!driver) throw new Error(`Unknown SQL driver: ${manifest.sqlDriver.driver}`);
    const start = Date.now();
    const rows = await driver.query(connectionString, input.sql);
    return { rows, durationMs: Date.now() - start };
  }

  throw new Error("No SQL driver available");
}

export async function sqlExecute(input: {
  accountId: string;
  resourceId?: string;
  resourceTypeId?: string;
  sql: string;
  params?: unknown[];
}): Promise<{ affectedRows: number }> {
  const { client, plugin, credentials } = await getClientForAccount(input.accountId);
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
      if (!driver) throw new Error(`Unknown SQL driver: ${rtSqlDriver.driver}`);
      const affectedRows = await driver.execute(connectionString, input.sql, params);
      return { affectedRows };
    }
  }

  // Account-level SQL driver
  const manifest = plugin.manifest;
  if (manifest.sqlDriver) {
    const connectionString = credentials[manifest.sqlDriver.credentialKey] ?? "";
    const driver = sqlDrivers.get(manifest.sqlDriver.driver);
    if (!driver) throw new Error(`Unknown SQL driver: ${manifest.sqlDriver.driver}`);
    const affectedRows = await driver.execute(connectionString, input.sql, params);
    return { affectedRows };
  }

  throw new Error("No SQL driver available");
}

// ── KV ──────────────────────────────────────────────────────────────────────

export async function kvCommand(input: {
  accountId: string;
  command: string;
  args: (string | number)[];
}): Promise<unknown> {
  const { plugin, credentials } = await getClientForAccount(input.accountId);
  const manifest = plugin.manifest;
  if (!manifest.kvDriver) throw new Error("No KV driver available");

  const connectionString = credentials[manifest.kvDriver.credentialKey] ?? "";
  const driver = kvDrivers.get(manifest.kvDriver.driver);
  if (!driver) throw new Error(`Unknown KV driver: ${manifest.kvDriver.driver}`);

  return driver.command(connectionString, input.command, input.args);
}

// ── Docker ──────────────────────────────────────────────────────────────────

export async function dockerCommand(input: {
  accountId: string;
  op: string;
  params?: Record<string, unknown>;
}): Promise<unknown> {
  const { plugin, credentials } = await getClientForAccount(input.accountId);
  const manifest = plugin.manifest;
  if (!manifest.dockerDriver) throw new Error("No Docker driver available");

  const dockerHost = credentials[manifest.dockerDriver.credentialKey] ?? "";
  const driver = dockerDrivers.get(manifest.dockerDriver.driver);
  if (!driver) throw new Error(`Unknown Docker driver: ${manifest.dockerDriver.driver}`);

  return driver.command(dockerHost, input.op, input.params);
}

// ── Storage ─────────────────────────────────────────────────────────────────

export async function storageList(input: {
  accountId: string;
  bucket: string;
  prefix: string;
}): Promise<Array<{ key: string; name: string; size: number; lastModified: string; isDirectory: boolean }>> {
  const { client } = await getClientForAccount(input.accountId);
  if (!client.listStorageObjects) throw new Error("Plugin does not support storage listing");
  return client.listStorageObjects(input.bucket, input.prefix);
}

export async function storageMakeFolder(input: {
  accountId: string;
  bucket: string;
  key: string;
}): Promise<void> {
  const { client } = await getClientForAccount(input.accountId);
  if (!client.makeStorageFolder) throw new Error("Plugin does not support folder creation");
  await client.makeStorageFolder(input.bucket, input.key);
}

export async function storageDelete(input: {
  accountId: string;
  bucket: string;
  key: string;
}): Promise<void> {
  const { client } = await getClientForAccount(input.accountId);
  if (!client.deleteStorageObject) throw new Error("Plugin does not support object deletion");
  await client.deleteStorageObject(input.bucket, input.key);
}

export async function storageStats(input: {
  accountId: string;
  bucket: string;
}): Promise<{ count: number; size: string }> {
  const { client } = await getClientForAccount(input.accountId);
  if (!client.fetchStorageStats) throw new Error("Plugin does not support storage stats");
  return client.fetchStorageStats(input.bucket);
}

// ── SFTP ────────────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getSshConfig(client: any): { host: string; port: number; username: string; privateKey: string } {
  const config = client.getSshConfig?.();
  if (!config) throw new Error("Plugin does not support SSH");
  return config;
}

export async function sftpList(input: {
  accountId: string;
  path: string;
}): Promise<SftpEntry[]> {
  const { client } = await getClientForAccount(input.accountId);
  const config = getSshConfig(client);
  return sftpListImpl(config, input.path);
}

export async function sftpMkdir(input: {
  accountId: string;
  path: string;
}): Promise<void> {
  const { client } = await getClientForAccount(input.accountId);
  const config = getSshConfig(client);
  await sftpMkdirImpl(config, input.path);
}

export async function sftpDelete(input: {
  accountId: string;
  path: string;
  isDir: boolean;
}): Promise<void> {
  const { client } = await getClientForAccount(input.accountId);
  const config = getSshConfig(client);
  await sftpDeleteImpl(config, input.path, input.isDir);
}
