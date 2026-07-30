/**
 * UI-parity tools — exposes SQL, KV, Docker, SSH-exec, storage, secret-version,
 * and credential-export operations as agent-callable tools. Wraps the same
 * services that back `/api/...` routes used by the React UI.
 */
import { z } from "zod";
import { sqlDrivers, kvDrivers, dockerDrivers } from "../services/drivers";
import { rewriteConnectionForTunnel } from "../services/tunnel-resolver";
import { getClientForAccount, getClientForResource } from "../services/plugin-clients";
import { resolveSshConfig, sshExec } from "../services/ssh";
import { HostKeyTrustRequiredError } from "../services/ssh-host-keys";
import { logAudit } from "../services/audit";
import { ok, err, type ToolDefinition } from "./types";

const SIDECAR_RETRY_HINT =
  "If this is a managed-database provider (Neon, RDS, Cloud SQL, DO managed databases, …), retry with " +
  "`pluginId` set to the SQL sidecar plugin (e.g. 'postgres', 'mysql') and `parentResourceId` set to the " +
  "database resource id — see list_resource_sidecars for what the resource exposes.";

const NO_SQL_DRIVER_HINT = `No SQL driver available for this account. ${SIDECAR_RETRY_HINT}`;

export function connectionTools(): ToolDefinition[] {
  return [
    {
      name: "sql_query",
      title: "Run read SQL query",
      description:
        "Run a read-only SQL query (SELECT, SHOW, EXPLAIN) against an account- or per-resource SQL driver. Returns rows. " +
        "Pass `resourceId`+`resourceTypeId` to target a per-resource database; omit them to use the account's primary SQL connection. " +
        "For managed-database providers whose own plugin has no SQL driver (Neon, RDS, Cloud SQL, DO managed databases, …), pass " +
        "`pluginId` of the SQL sidecar plugin (e.g. 'postgres', 'mysql') and `parentResourceId` = the database resource id " +
        "(see list_resource_sidecars).",
      inputSchema: {
        accountId: z.string(),
        sql: z.string(),
        resourceId: z.string().optional(),
        resourceTypeId: z.string().optional(),
        pluginId: z.string().optional(),
        parentResourceId: z.string().optional(),
      },
      risk: "read",
      permission: "resources:execute",
      handler: async (input, auth) => {
        const { accountId, sql, resourceId, resourceTypeId, pluginId, parentResourceId } =
          input as {
            accountId: string;
            sql: string;
            resourceId?: string;
            resourceTypeId?: string;
            pluginId?: string;
            parentResourceId?: string;
          };
        const ctx = pluginId
          ? await getClientForResource(pluginId, accountId, auth.organizationId, parentResourceId)
          : await getClientForAccount(accountId, auth.organizationId);
        if (!ctx) return err("Account or sidecar resource not found");
        const { client, plugin, credentials } = ctx;

        // REST-based query (BigQuery, Databricks)
        if (resourceId && client.executeQuery) {
          const result = await client.executeQuery(resourceId, accountId, sql);
          return ok(result);
        }

        // Per-resource SQL driver
        if (resourceId && resourceTypeId) {
          const typeDef = plugin.resourceTypes.find((t) => t.id === resourceTypeId);
          const rtDriver = typeDef?.resourceSqlDriver;
          if (rtDriver) {
            let cs = await client.resolveOutput(
              resourceTypeId,
              resourceId,
              rtDriver.connectionStringOutputKey,
              accountId,
            );
            cs = await rewriteConnectionForTunnel(accountId, cs);
            const driver = sqlDrivers.get(rtDriver.driver);
            if (!driver) return err(`Unknown SQL driver: ${rtDriver.driver}`);
            const rows = await driver.query(cs, sql);
            return ok({ rows: rows.slice(0, 500), truncated: rows.length > 500 });
          }
        }

        // Account-level SQL driver
        const manifest = plugin.manifest;
        if (manifest.sqlDriver) {
          let cs = credentials[manifest.sqlDriver.credentialKey] ?? "";
          cs = await rewriteConnectionForTunnel(accountId, cs);
          const driver = sqlDrivers.get(manifest.sqlDriver.driver);
          if (!driver) return err(`Unknown SQL driver: ${manifest.sqlDriver.driver}`);
          const rows = await driver.query(cs, sql);
          return ok({ rows: rows.slice(0, 500), truncated: rows.length > 500 });
        }

        return err(NO_SQL_DRIVER_HINT);
      },
    },

    {
      name: "sql_execute",
      title: "Run write SQL statement",
      description:
        "Execute a mutating SQL statement (INSERT/UPDATE/DELETE/DDL). Returns affectedRows. Audit-logged. The chat surface confirms before invoking. " +
        "For managed-database providers whose own plugin has no SQL driver (Neon, RDS, Cloud SQL, DO managed databases, …), pass " +
        "`pluginId` of the SQL sidecar plugin (e.g. 'postgres', 'mysql') and `parentResourceId` = the database resource id " +
        "(see list_resource_sidecars).",
      inputSchema: {
        accountId: z.string(),
        sql: z.string(),
        params: z.array(z.unknown()).optional(),
        resourceId: z.string().optional(),
        resourceTypeId: z.string().optional(),
        pluginId: z.string().optional(),
        parentResourceId: z.string().optional(),
      },
      risk: "destructive",
      permission: "resources:execute",
      handler: async (input, auth) => {
        const { accountId, sql, params, resourceId, resourceTypeId, pluginId, parentResourceId } =
          input as {
            accountId: string;
            sql: string;
            params?: unknown[];
            resourceId?: string;
            resourceTypeId?: string;
            pluginId?: string;
            parentResourceId?: string;
          };
        const ctx = pluginId
          ? await getClientForResource(pluginId, accountId, auth.organizationId, parentResourceId)
          : await getClientForAccount(accountId, auth.organizationId);
        if (!ctx) return err("Account or sidecar resource not found");
        const { client, plugin, credentials } = ctx;

        const sqlSnippet = sql.slice(0, 200);
        void logAudit({
          organizationId: auth.organizationId,
          userId: auth.userId,
          action: "sql.execute",
          entityType: "account",
          entityId: accountId,
          metadata: { resourceId, resourceTypeId, sqlSnippet, source: auth.source },
        });

        const paramList = params ?? [];

        if (resourceId && resourceTypeId) {
          const typeDef = plugin.resourceTypes.find((t) => t.id === resourceTypeId);
          const rtDriver = typeDef?.resourceSqlDriver;
          if (rtDriver) {
            let cs = await client.resolveOutput(
              resourceTypeId,
              resourceId,
              rtDriver.connectionStringOutputKey,
              accountId,
            );
            cs = await rewriteConnectionForTunnel(accountId, cs);
            const driver = sqlDrivers.get(rtDriver.driver);
            if (!driver) return err(`Unknown SQL driver: ${rtDriver.driver}`);
            const affected = await driver.execute(cs, sql, paramList);
            return ok({ affectedRows: affected });
          }
        }

        const manifest = plugin.manifest;
        if (manifest.sqlDriver) {
          let cs = credentials[manifest.sqlDriver.credentialKey] ?? "";
          cs = await rewriteConnectionForTunnel(accountId, cs);
          const driver = sqlDrivers.get(manifest.sqlDriver.driver);
          if (!driver) return err(`Unknown SQL driver: ${manifest.sqlDriver.driver}`);
          const affected = await driver.execute(cs, sql, paramList);
          return ok({ affectedRows: affected });
        }

        return err(NO_SQL_DRIVER_HINT);
      },
    },

    {
      name: "introspect_sql_schema",
      title: "Introspect SQL schema",
      description:
        "Return the database's table/column metadata used by the SQL editor's autocomplete. Useful before asking the model to write queries. " +
        "For managed-database providers whose own plugin has no SQL client (Neon, RDS, Cloud SQL, DO managed databases, …), pass " +
        "`pluginId` of the SQL sidecar plugin (e.g. 'postgres', 'mysql') and `parentResourceId` = the database resource id " +
        "(see list_resource_sidecars).",
      inputSchema: {
        accountId: z.string(),
        pluginId: z.string().optional(),
        parentResourceId: z.string().optional(),
      },
      risk: "read",
      permission: "resources:execute",
      handler: async (input, auth) => {
        const { accountId, pluginId, parentResourceId } = input as {
          accountId: string;
          pluginId?: string;
          parentResourceId?: string;
        };
        const ctx = pluginId
          ? await getClientForResource(pluginId, accountId, auth.organizationId, parentResourceId)
          : await getClientForAccount(accountId, auth.organizationId);
        if (!ctx) return err("Account or sidecar resource not found");
        if (!ctx.client.introspect)
          return err("Plugin does not support SQL introspection directly. " + SIDECAR_RETRY_HINT);
        const tables = await ctx.client.introspect();
        return ok(tables);
      },
    },

    {
      name: "kv_command",
      title: "Run KV command",
      description:
        "Run a Redis/Memcached/MongoDB-style command via the plugin's KV driver. Pass the command verb (e.g. GET, SET, HGETALL) and args. Audit-logged for write commands.",
      inputSchema: {
        accountId: z.string(),
        command: z.string(),
        args: z.array(z.union([z.string(), z.number()])),
        pluginId: z.string().optional(),
        parentResourceId: z.string().optional(),
      },
      risk: "destructive",
      permission: "resources:execute",
      handler: async (input, auth) => {
        const { accountId, command, args, pluginId, parentResourceId } = input as {
          accountId: string;
          command: string;
          args: (string | number)[];
          pluginId?: string;
          parentResourceId?: string;
        };
        const ctx = pluginId
          ? await getClientForResource(pluginId, accountId, auth.organizationId, parentResourceId)
          : await getClientForAccount(accountId, auth.organizationId);
        if (!ctx) return err("Account or peer resource not found");
        const { plugin, credentials } = ctx;
        const manifest = plugin.manifest;
        if (!manifest.kvDriver) return err("No KV driver available for this account");

        let cs = credentials[manifest.kvDriver.credentialKey] ?? "";
        cs = await rewriteConnectionForTunnel(accountId, cs);
        const driver = kvDrivers.get(manifest.kvDriver.driver);
        if (!driver) return err(`Unknown KV driver: ${manifest.kvDriver.driver}`);

        void logAudit({
          organizationId: auth.organizationId,
          userId: auth.userId,
          action: "kv.command",
          entityType: "account",
          entityId: accountId,
          metadata: { command, source: auth.source },
        });

        const result = await driver.command(cs, command, args);
        return ok({ result });
      },
    },

    {
      name: "docker_command",
      title: "Run Docker command",
      description:
        "Run a Docker operation (containers.list, container.start, container.stop, container.restart, container.logs, etc.) via the Docker driver. Audit-logged.",
      inputSchema: {
        accountId: z.string(),
        op: z.string(),
        params: z.record(z.string(), z.unknown()).optional(),
      },
      risk: "destructive",
      permission: "resources:execute",
      handler: async (input, auth) => {
        const { accountId, op, params } = input as {
          accountId: string;
          op: string;
          params?: Record<string, unknown>;
        };
        const ctx = await getClientForAccount(accountId, auth.organizationId);
        if (!ctx) return err("Account not found");
        const { plugin, credentials } = ctx;
        const manifest = plugin.manifest;
        if (!manifest.dockerDriver) return err("No Docker driver available for this account");
        let dockerHost = credentials[manifest.dockerDriver.credentialKey] ?? "";
        dockerHost = await rewriteConnectionForTunnel(accountId, dockerHost);
        const driver = dockerDrivers.get(manifest.dockerDriver.driver);
        if (!driver) return err(`Unknown Docker driver: ${manifest.dockerDriver.driver}`);

        void logAudit({
          organizationId: auth.organizationId,
          userId: auth.userId,
          action: "docker.command",
          entityType: "account",
          entityId: accountId,
          metadata: { op, source: auth.source },
        });

        const result = await driver.command(dockerHost, op, params);
        return ok({ result });
      },
    },

    {
      name: "ssh_exec",
      title: "Run SSH command",
      description:
        "Execute a single command on a remote host via SSH. Returns stdout. For plugins that natively expose SSH (Fly machines, Hetzner servers), the plugin's getSshConfig is used and no key id is needed. Otherwise pass sshKeyId (see list_ssh_keys) + sshHost + sshUsername. Audit-logged.",
      inputSchema: {
        accountId: z.string(),
        command: z.string(),
        sshKeyId: z.string().optional(),
        sshHost: z.string().optional(),
        sshUsername: z.string().optional(),
      },
      risk: "destructive",
      permission: "resources:execute",
      handler: async (input, auth) => {
        const { accountId, command, sshKeyId, sshHost, sshUsername } = input as {
          accountId: string;
          command: string;
          sshKeyId?: string;
          sshHost?: string;
          sshUsername?: string;
        };
        const ctx = await getClientForAccount(accountId, auth.organizationId);
        if (!ctx) return err("Account not found");

        const resolveInput: { sshKeyId?: string; sshHost?: string; sshUsername?: string } = {};
        if (sshKeyId) resolveInput.sshKeyId = sshKeyId;
        if (sshHost) resolveInput.sshHost = sshHost;
        if (sshUsername) resolveInput.sshUsername = sshUsername;

        let config;
        try {
          config = await resolveSshConfig(ctx.client, auth.organizationId, resolveInput);
        } catch (e) {
          return err(e instanceof Error ? e.message : "Failed to resolve SSH config");
        }

        const commandSnippet = command.slice(0, 200);
        try {
          const stdout = await sshExec(auth.organizationId, config, command);
          void logAudit({
            organizationId: auth.organizationId,
            userId: auth.userId,
            action: "ssh.exec",
            entityType: "account",
            entityId: accountId,
            metadata: { sshHost: config.host, commandSnippet, source: auth.source, exitCode: 0 },
          });
          return ok({ stdout, code: 0 });
        } catch (e) {
          let message = e instanceof Error ? e.message : "SSH exec failed";
          if (e instanceof HostKeyTrustRequiredError) {
            message +=
              ` Have the user verify this fingerprint out-of-band, then call trust_ssh_host ` +
              `{ host: "${e.host}", port: ${e.port}, fingerprint: "${e.presentedFingerprint}"` +
              (e.storedFingerprint ? `, previousFingerprint: "${e.storedFingerprint}"` : "") +
              ` } and retry.`;
          }
          void logAudit({
            organizationId: auth.organizationId,
            userId: auth.userId,
            action: "ssh.exec",
            entityType: "account",
            entityId: accountId,
            metadata: { sshHost: config.host, commandSnippet, source: auth.source, error: message },
          });
          return err(message);
        }
      },
    },

    {
      name: "list_storage_objects",
      title: "List storage objects",
      description:
        "List objects in a cloud storage bucket at a given prefix (S3, GCS, R2, Azure Blob, etc.).",
      inputSchema: {
        accountId: z.string(),
        bucket: z.string(),
        prefix: z.string(),
      },
      risk: "read",
      permission: "storage:read",
      handler: async (input, auth) => {
        const { accountId, bucket, prefix } = input as {
          accountId: string;
          bucket: string;
          prefix: string;
        };
        const ctx = await getClientForAccount(accountId, auth.organizationId);
        if (!ctx) return err("Account not found");
        if (!ctx.client.listStorageObjects) return err("Plugin does not support storage listing");
        const result = await ctx.client.listStorageObjects(bucket, prefix);
        return ok(result);
      },
    },

    {
      name: "make_storage_folder",
      title: "Create storage folder",
      description: "Create a folder/prefix in a cloud storage bucket.",
      inputSchema: {
        accountId: z.string(),
        bucket: z.string(),
        key: z.string(),
      },
      risk: "write",
      permission: "storage:write",
      handler: async (input, auth) => {
        const { accountId, bucket, key } = input as {
          accountId: string;
          bucket: string;
          key: string;
        };
        const ctx = await getClientForAccount(accountId, auth.organizationId);
        if (!ctx) return err("Account not found");
        if (!ctx.client.makeStorageFolder) return err("Plugin does not support folder creation");
        await ctx.client.makeStorageFolder(bucket, key);
        void logAudit({
          organizationId: auth.organizationId,
          userId: auth.userId,
          action: "storage.mkdir",
          entityType: "account",
          entityId: accountId,
          metadata: { bucket, key, source: auth.source },
        });
        return ok({ ok: true });
      },
    },

    {
      name: "delete_storage_object",
      title: "Delete storage object",
      description:
        "Permanently delete an object (or folder prefix) from a cloud storage bucket. Audit-logged.",
      inputSchema: {
        accountId: z.string(),
        bucket: z.string(),
        key: z.string(),
      },
      risk: "destructive",
      permission: "storage:write",
      handler: async (input, auth) => {
        const { accountId, bucket, key } = input as {
          accountId: string;
          bucket: string;
          key: string;
        };
        const ctx = await getClientForAccount(accountId, auth.organizationId);
        if (!ctx) return err("Account not found");
        if (!ctx.client.deleteStorageObject) return err("Plugin does not support object deletion");
        await ctx.client.deleteStorageObject(bucket, key);
        void logAudit({
          organizationId: auth.organizationId,
          userId: auth.userId,
          action: "storage.delete",
          entityType: "account",
          entityId: accountId,
          metadata: { bucket, key, source: auth.source },
        });
        return ok({ ok: true });
      },
    },

    {
      name: "list_secret_versions",
      title: "List secret versions",
      description:
        "List the versions of a versioned-secret resource (GCP Secret Manager, etc.). Returns id, state, createdAt per version.",
      inputSchema: {
        pluginId: z.string(),
        accountId: z.string(),
        resourceTypeId: z.string(),
        resourceId: z.string(),
        parentResourceId: z.string().optional(),
      },
      risk: "read",
      permission: "secrets:read",
      handler: async (input, auth) => {
        const { pluginId, accountId, resourceTypeId, resourceId, parentResourceId } = input as {
          pluginId: string;
          accountId: string;
          resourceTypeId: string;
          resourceId: string;
          parentResourceId?: string;
        };
        const ctx = await getClientForResource(
          pluginId,
          accountId,
          auth.organizationId,
          parentResourceId,
        );
        if (!ctx) return err("Account or peer resource not found");
        if (!ctx.client.listSecretVersions) return err("Plugin does not support secret versions");
        const versions = await ctx.client.listSecretVersions(resourceTypeId, resourceId, accountId);
        return ok(versions);
      },
    },

    {
      name: "access_secret_version",
      title: "Access secret version (reveal)",
      description:
        "Return the plaintext value of a specific secret version. Audit-logged as a reveal — handle with care, do NOT echo back the value verbatim in chat unless the user asks.",
      inputSchema: {
        pluginId: z.string(),
        accountId: z.string(),
        resourceTypeId: z.string(),
        resourceId: z.string(),
        versionId: z.string(),
        parentResourceId: z.string().optional(),
      },
      risk: "destructive",
      permission: "secrets:read",
      handler: async (input, auth) => {
        const { pluginId, accountId, resourceTypeId, resourceId, versionId, parentResourceId } =
          input as {
            pluginId: string;
            accountId: string;
            resourceTypeId: string;
            resourceId: string;
            versionId: string;
            parentResourceId?: string;
          };
        const ctx = await getClientForResource(
          pluginId,
          accountId,
          auth.organizationId,
          parentResourceId,
        );
        if (!ctx) return err("Account or peer resource not found");
        if (!ctx.client.accessSecretVersion) return err("Plugin does not support secret reveal");
        const value = await ctx.client.accessSecretVersion(
          resourceTypeId,
          resourceId,
          accountId,
          versionId,
        );
        void logAudit({
          organizationId: auth.organizationId,
          userId: auth.userId,
          action: "secret.access",
          entityType: "resource",
          entityId: resourceId,
          metadata: { pluginId, resourceTypeId, versionId, source: auth.source },
        });
        return ok({ value });
      },
    },

    {
      name: "add_secret_version",
      title: "Add secret version",
      description:
        "Add a new version (rotation) to a versioned-secret resource. Returns the new version id. Audit-logged.",
      inputSchema: {
        pluginId: z.string(),
        accountId: z.string(),
        resourceTypeId: z.string(),
        resourceId: z.string(),
        value: z.string(),
        parentResourceId: z.string().optional(),
      },
      risk: "write",
      permission: "secrets:write",
      handler: async (input, auth) => {
        const { pluginId, accountId, resourceTypeId, resourceId, value, parentResourceId } =
          input as {
            pluginId: string;
            accountId: string;
            resourceTypeId: string;
            resourceId: string;
            value: string;
            parentResourceId?: string;
          };
        const ctx = await getClientForResource(
          pluginId,
          accountId,
          auth.organizationId,
          parentResourceId,
        );
        if (!ctx) return err("Account or peer resource not found");
        if (!ctx.client.addSecretVersion) return err("Plugin does not support adding versions");
        const version = await ctx.client.addSecretVersion(
          resourceTypeId,
          resourceId,
          accountId,
          value,
        );
        void logAudit({
          organizationId: auth.organizationId,
          userId: auth.userId,
          action: "secret.add_version",
          entityType: "resource",
          entityId: resourceId,
          metadata: { pluginId, resourceTypeId, versionId: version.id, source: auth.source },
        });
        return ok(version);
      },
    },

    {
      name: "modify_secret_version",
      title: "Enable/disable/destroy secret version",
      description:
        "Enable, disable, or destroy a specific secret version. Destroy is irreversible. Audit-logged.",
      inputSchema: {
        pluginId: z.string(),
        accountId: z.string(),
        resourceTypeId: z.string(),
        resourceId: z.string(),
        versionId: z.string(),
        action: z.enum(["enable", "disable", "destroy"]),
        parentResourceId: z.string().optional(),
      },
      risk: "destructive",
      permission: "secrets:write",
      handler: async (input, auth) => {
        const {
          pluginId,
          accountId,
          resourceTypeId,
          resourceId,
          versionId,
          action,
          parentResourceId,
        } = input as {
          pluginId: string;
          accountId: string;
          resourceTypeId: string;
          resourceId: string;
          versionId: string;
          action: "enable" | "disable" | "destroy";
          parentResourceId?: string;
        };
        const ctx = await getClientForResource(
          pluginId,
          accountId,
          auth.organizationId,
          parentResourceId,
        );
        if (!ctx) return err("Account or peer resource not found");
        if (!ctx.client.modifySecretVersion)
          return err("Plugin does not support modifying versions");
        const updated = await ctx.client.modifySecretVersion(
          resourceTypeId,
          resourceId,
          accountId,
          versionId,
          action,
        );
        void logAudit({
          organizationId: auth.organizationId,
          userId: auth.userId,
          action: `secret.${action}`,
          entityType: "resource",
          entityId: resourceId,
          metadata: { pluginId, resourceTypeId, versionId, source: auth.source },
        });
        return ok(updated);
      },
    },

    {
      name: "export_credential",
      title: "Export downloadable credential",
      description:
        "Generate a downloadable credential (IAM access key, service-account JSON, storage connection string, etc.) for a resource. The secret is shown ONCE. Audit-logged.",
      inputSchema: {
        pluginId: z.string(),
        accountId: z.string(),
        resourceTypeId: z.string(),
        resourceId: z.string(),
        formatId: z.string(),
        parentResourceId: z.string().optional(),
      },
      risk: "destructive",
      permission: "secrets:read",
      handler: async (input, auth) => {
        const { pluginId, accountId, resourceTypeId, resourceId, formatId, parentResourceId } =
          input as {
            pluginId: string;
            accountId: string;
            resourceTypeId: string;
            resourceId: string;
            formatId: string;
            parentResourceId?: string;
          };
        const ctx = await getClientForResource(
          pluginId,
          accountId,
          auth.organizationId,
          parentResourceId,
        );
        if (!ctx) return err("Account or peer resource not found");
        if (!ctx.client.exportCredential) return err("Plugin does not support credential export");
        const exp = await ctx.client.exportCredential(
          resourceTypeId,
          resourceId,
          accountId,
          formatId,
        );
        void logAudit({
          organizationId: auth.organizationId,
          userId: auth.userId,
          action: "credential.export",
          entityType: "resource",
          entityId: resourceId,
          metadata: { pluginId, resourceTypeId, formatId, source: auth.source },
        });
        return ok(exp);
      },
    },
  ];
}
