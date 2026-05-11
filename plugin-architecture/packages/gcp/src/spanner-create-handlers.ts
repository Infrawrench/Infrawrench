import type { CreateResourceConfig, ResourceInstance } from "@infrawrench/plugin-base";
import type { GcpCreateContext } from "./create-context.js";

export const spannerCreateConfigHandlers: Record<
  string,
  (ctx: GcpCreateContext, parentResourceId?: string) => Promise<CreateResourceConfig>
> = {
  "spanner-instance": async (ctx, parentResourceId) => {
    return {
      fields: [
        {
          key: "name",
          label: "Instance Name",
          kind: "text",
          required: true,
        },
        {
          key: "displayName",
          label: "Display Name",
          kind: "text",
          required: true,
        },
        {
          key: "config",
          label: "Instance Config",
          kind: "select",
          required: true,
          options: [
            { id: "regional-us-central1", label: "Regional US Central1" },
            { id: "regional-us-east1", label: "Regional US East1" },
            { id: "regional-us-west1", label: "Regional US West1" },
            { id: "regional-europe-west1", label: "Regional Europe West1" },
            { id: "regional-asia-east1", label: "Regional Asia East1" },
            { id: "nam6", label: "Multi-region NAM6" },
            { id: "nam-eur-asia1", label: "Multi-region NAM-EUR-ASIA1" },
          ],
          defaultValue: "regional-us-central1",
        },
        {
          key: "nodeCount",
          label: "Node Count",
          kind: "number",
          required: true,
          defaultValue: "1",
          minValue: 1,
          stepValue: 1,
        },
      ],
    };
  },
  "spanner-database": async (ctx, parentResourceId) => {
    const hasParent = !!parentResourceId;
    const fields: CreateResourceConfig["fields"] = [];
    if (!hasParent) {
      fields.push({
        key: "instance",
        label: "Instance",
        kind: "text",
        required: true,
        description: "The parent Spanner instance ID.",
      });
    }
    fields.push(
      {
        key: "name",
        label: "Database Name",
        kind: "text",
        required: true,
        description:
          "Between 2 and 30 characters, starting with a letter. Lowercase letters, numbers, hyphens, and underscores allowed.",
      },
      {
        key: "dialect",
        label: "Dialect",
        kind: "select",
        required: true,
        options: [
          { id: "GOOGLE_STANDARD_SQL", label: "Google Standard SQL" },
          { id: "POSTGRESQL", label: "PostgreSQL" },
        ],
        defaultValue: "GOOGLE_STANDARD_SQL",
      },
      {
        key: "ddl",
        label: "Schema (DDL)",
        kind: "text",
        required: false,
        multiline: true,
        description:
          "Optional Data Definition Language statements separated by semicolons. Leave blank to create an empty database.",
        placeholder:
          "CREATE TABLE Users (\n  UserId STRING(36) NOT NULL,\n  CreatedAt TIMESTAMP NOT NULL OPTIONS (allow_commit_timestamp=true),\n) PRIMARY KEY (UserId);",
      },
    );
    return { fields };
  },
  "spanner-backup": async (ctx, parentResourceId) => {
    const hasParent = !!parentResourceId;
    const fields: CreateResourceConfig["fields"] = [];
    if (!hasParent) {
      fields.push({
        key: "instance",
        label: "Instance",
        kind: "text",
        required: true,
        description: "The parent Spanner instance ID.",
      });
    }
    fields.push(
      {
        key: "name",
        label: "Backup ID",
        kind: "text",
        required: true,
        description: "A unique name for the backup within the instance.",
      },
      {
        key: "database",
        label: "Source Database",
        kind: "text",
        required: true,
        description: "The database ID to back up.",
      },
      {
        key: "expireTime",
        label: "Expire Time",
        kind: "datetime",
        datetimeMode: "datetime",
        required: true,
        description: "When the backup should expire. Must be 6 hours to 1 year from now.",
      },
    );
    return { fields };
  },
};

export const spannerCreateResourceHandlers: Record<
  string,
  (
    ctx: GcpCreateContext,
    accountId: string,
    fields: Record<string, string>,
    parentResourceId?: string,
  ) => Promise<ResourceInstance>
> = {
  "spanner-instance": async (ctx, accountId, fields, parentResourceId) => {
    const p = ctx.project;
    const tok = await ctx.token();
    const name = fields["name"] ?? "";
    const displayName = fields["displayName"] ?? "";
    const config = fields["config"] ?? "regional-us-central1";
    const nodeCount = Math.max(1, Number(fields["nodeCount"] ?? 1));

    const res = await fetch(`https://spanner.googleapis.com/v1/projects/${p}/instances`, {
      method: "POST",
      headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        instanceId: name,
        instance: {
          displayName,
          config: `projects/${p}/instanceConfigs/${config}`,
          nodeCount,
        },
      }),
    });
    if (!res.ok) throw new Error(`Spanner API ${res.status}: ${await res.text()}`);
    const now = ctx.now();
    return {
      id: ctx.id(accountId, "spanner-instance", name),
      pluginId: "gcp",
      resourceTypeId: "spanner-instance",
      accountId,
      displayName: displayName || name,
      fields: {
        name,
        displayName,
        config,
        nodeCount,
        processingUnits: 0,
        state: "CREATING",
      },
      resolvedOutputs: {},
      secretStates: [],
      externalId: name,
      createdAt: now,
      updatedAt: now,
    };
  },
  "spanner-database": async (ctx, accountId, fields, parentResourceId) => {
    const p = ctx.project;
    const tok = await ctx.token();
    const instance = fields["instance"] || parentResourceId?.split(":")[2] || "";
    const name = fields["name"] ?? "";
    const dialect = fields["dialect"] ?? "GOOGLE_STANDARD_SQL";
    const ddlRaw = fields["ddl"] ?? "";
    if (!instance || !name)
      throw new Error("Spanner database creation requires an instance and a name");

    const extraStatements = ddlRaw
      .split(";")
      .map((s: string) => s.trim())
      .filter((s: string) => s.length > 0);

    const createStatement =
      dialect === "POSTGRESQL" ? `CREATE DATABASE "${name}"` : `CREATE DATABASE \`${name}\``;

    const body: Record<string, unknown> = {
      createStatement,
      databaseDialect: dialect,
    };
    if (extraStatements.length > 0) {
      body["extraStatements"] = extraStatements;
    }

    const res = await fetch(
      `https://spanner.googleapis.com/v1/projects/${p}/instances/${instance}/databases`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
    );
    if (!res.ok) throw new Error(`Spanner API ${res.status}: ${await res.text()}`);
    const now = ctx.now();
    const externalId = `${instance}/${name}`;
    return {
      id: ctx.id(accountId, "spanner-database", externalId),
      pluginId: "gcp",
      resourceTypeId: "spanner-database",
      accountId,
      displayName: name,
      parentResourceId: ctx.id(accountId, "spanner-instance", instance),
      fields: {
        name,
        instance,
        state: "CREATING",
        dialect,
        versionRetentionPeriod: "",
        earliestVersionTime: "",
        createTime: now,
        enableDropProtection: false,
        encryptionConfig: "",
        defaultLeader: "",
      },
      resolvedOutputs: {},
      secretStates: [],
      externalId,
      createdAt: now,
      updatedAt: now,
    };
  },
  "spanner-backup": async (ctx, accountId, fields, parentResourceId) => {
    const p = ctx.project;
    const tok = await ctx.token();
    const instance = fields["instance"] || parentResourceId?.split(":")[2] || "";
    const name = fields["name"] ?? "";
    const database = fields["database"] ?? "";
    const expireTime = fields["expireTime"] ?? "";
    if (!instance || !name || !database || !expireTime)
      throw new Error(
        "Spanner backup creation requires instance, name, source database, and expire time",
      );

    const res = await fetch(
      `https://spanner.googleapis.com/v1/projects/${p}/instances/${instance}/backups?backupId=${encodeURIComponent(name)}`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          database: `projects/${p}/instances/${instance}/databases/${database}`,
          expireTime,
        }),
      },
    );
    if (!res.ok) throw new Error(`Spanner API ${res.status}: ${await res.text()}`);
    const now = ctx.now();
    const externalId = `${instance}/${name}`;
    return {
      id: ctx.id(accountId, "spanner-backup", externalId),
      pluginId: "gcp",
      resourceTypeId: "spanner-backup",
      accountId,
      displayName: name,
      parentResourceId: ctx.id(accountId, "spanner-instance", instance),
      fields: {
        name,
        instance,
        database,
        state: "CREATING",
        sizeBytes: "0",
        createTime: now,
        expireTime,
        versionTime: "",
        backupSchedules: "",
      },
      resolvedOutputs: {},
      secretStates: [],
      externalId,
      createdAt: now,
      updatedAt: now,
    };
  },
};
