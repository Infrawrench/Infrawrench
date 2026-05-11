import type { CreateResourceConfig, ResourceInstance } from "@infrawrench/plugin-base";
import { GCP_REGIONS } from "./regions.js";
import { engineInfoFromVersion } from "./cloudsql-engine.js";
import type { GcpCreateContext } from "./create-context.js";

export const cloudsqlCreateConfigHandlers: Record<
  string,
  (ctx: GcpCreateContext, parentResourceId?: string) => Promise<CreateResourceConfig>
> = {
  "cloudsql-instance": async (ctx, parentResourceId) => {
    return {
      fields: [
        { key: "name", label: "Instance Name", kind: "text", required: true },
        {
          key: "databaseVersion",
          label: "Database Version",
          kind: "select",
          required: true,
          options: [
            { id: "POSTGRES_18", label: "PostgreSQL 18" },
            { id: "POSTGRES_17", label: "PostgreSQL 17" },
            { id: "POSTGRES_16", label: "PostgreSQL 16" },
            { id: "POSTGRES_15", label: "PostgreSQL 15" },
            { id: "POSTGRES_14", label: "PostgreSQL 14" },
            { id: "MYSQL_8_4", label: "MySQL 8.4" },
            { id: "MYSQL_8_0", label: "MySQL 8.0" },
            { id: "MYSQL_5_7", label: "MySQL 5.7" },
            { id: "SQLSERVER_2022_ENTERPRISE", label: "SQL Server 2022 Enterprise" },
            { id: "SQLSERVER_2022_STANDARD", label: "SQL Server 2022 Standard" },
            { id: "SQLSERVER_2022_EXPRESS", label: "SQL Server 2022 Express" },
            { id: "SQLSERVER_2022_WEB", label: "SQL Server 2022 Web" },
            { id: "SQLSERVER_2019_ENTERPRISE", label: "SQL Server 2019 Enterprise" },
            { id: "SQLSERVER_2019_STANDARD", label: "SQL Server 2019 Standard" },
            { id: "SQLSERVER_2019_EXPRESS", label: "SQL Server 2019 Express" },
            { id: "SQLSERVER_2019_WEB", label: "SQL Server 2019 Web" },
            { id: "SQLSERVER_2017_ENTERPRISE", label: "SQL Server 2017 Enterprise" },
            { id: "SQLSERVER_2017_STANDARD", label: "SQL Server 2017 Standard" },
            { id: "SQLSERVER_2017_EXPRESS", label: "SQL Server 2017 Express" },
            { id: "SQLSERVER_2017_WEB", label: "SQL Server 2017 Web" },
          ],
          defaultValue: "POSTGRES_18",
        },
        {
          key: "region",
          label: "Region",
          kind: "region-picker",
          required: true,
          regions: GCP_REGIONS,
          defaultValue: "us-central1",
        },
        {
          key: "tier",
          label: "Machine Tier",
          kind: "select",
          required: true,
          options: [
            { id: "db-f1-micro", label: "db-f1-micro (shared, 0.6 GB)" },
            { id: "db-g1-small", label: "db-g1-small (shared, 1.7 GB)" },
            { id: "db-n1-standard-1", label: "db-n1-standard-1 (1 vCPU, 3.75 GB)" },
            { id: "db-n1-standard-2", label: "db-n1-standard-2 (2 vCPU, 7.5 GB)" },
            { id: "db-n1-standard-4", label: "db-n1-standard-4 (4 vCPU, 15 GB)" },
            { id: "db-n1-highmem-2", label: "db-n1-highmem-2 (2 vCPU, 13 GB)" },
          ],
          defaultValue: "db-f1-micro",
        },
        {
          key: "diskSizeGb",
          label: "Disk Size (GB)",
          kind: "number",
          required: false,
          defaultValue: "10",
          minValue: 10,
          maxValue: 65536,
        },
        {
          key: "rootPassword",
          label: "Root Password",
          kind: "password",
          required: true,
          description: "Password for the default admin user (postgres / root / sqlserver)",
        },
        {
          key: "network",
          label: "VPC Network",
          kind: "resource-picker",
          required: false,
          description: "VPC network for private IP access",
          associationSources: [
            { pluginId: "gcp", resourceTypeId: "vpc-network", outputKey: "selfLink" },
          ],
        },
      ],
    };
  },
};

export const cloudsqlCreateResourceHandlers: Record<
  string,
  (
    ctx: GcpCreateContext,
    accountId: string,
    fields: Record<string, string>,
    parentResourceId?: string,
  ) => Promise<ResourceInstance>
> = {
  "cloudsql-instance": async (ctx, accountId, fields, parentResourceId) => {
    const p = ctx.project;
    const tok = await ctx.token();
    const name = fields["name"] ?? "";
    const databaseVersion = fields["databaseVersion"] ?? "POSTGRES_18";
    const region = fields["region"] ?? "us-central1";
    const tier = fields["tier"] ?? "db-f1-micro";
    const diskSizeGb = fields["diskSizeGb"] ?? "10";
    const rootPassword = fields["rootPassword"] ?? "";
    const network = fields["network"];
    const engine = engineInfoFromVersion(databaseVersion);

    const ipConfig: Record<string, unknown> = {};
    if (network) {
      const projectsIdx = network.indexOf("projects/");
      ipConfig.privateNetwork =
        projectsIdx >= 0 ? network.slice(projectsIdx) : `projects/${p}/global/networks/${network}`;
      ipConfig.ipv4Enabled = false;
    } else {
      ipConfig.ipv4Enabled = true;
    }

    const res = await fetch(`https://sqladmin.googleapis.com/v1/projects/${p}/instances`, {
      method: "POST",
      headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        name,
        databaseVersion,
        region,
        rootPassword,
        settings: {
          tier,
          edition: "ENTERPRISE",
          dataDiskSizeGb: diskSizeGb,
          ipConfiguration: ipConfig,
        },
      }),
    });
    if (!res.ok) throw new Error(`Cloud SQL API ${res.status}: ${await res.text()}`);
    const now = ctx.now();
    return {
      id: ctx.id(accountId, "cloudsql-instance", name),
      pluginId: "gcp",
      resourceTypeId: "cloudsql-instance",
      accountId,
      displayName: name,
      fields: {
        name,
        databaseVersion,
        region,
        tier,
        state: "PENDING_CREATE",
        availabilityType: "ZONAL",
      },
      resolvedOutputs: {
        connectionName: `${p}:${region}:${name}`,
        ipAddress: "",
        connectionUrl: "",
        username: engine.username,
        port: engine.port,
      },
      secretStates: [
        {
          fieldKey: "rootPassword",
          resolution: { kind: "plaintext", value: rootPassword },
        },
      ],
      externalId: name,
      createdAt: now,
      updatedAt: now,
    };
  },
};
