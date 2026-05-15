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
          key: "publicIp",
          label: "Public IP",
          kind: "select",
          required: true,
          description:
            "Public IP makes the instance reachable from the open internet. Disable to use private IP only — connections then require VPC reachability (Cloud VPN, Cloud Run/GCE in the VPC, IAP tunnel).",
          options: [
            { id: "true", label: "Enabled (recommended for desktop access)" },
            { id: "false", label: "Disabled (private IP only)" },
          ],
          defaultValue: "true",
        },
        {
          key: "authorizedNetworks",
          label: "Authorized Networks",
          kind: "text",
          multiline: true,
          required: false,
          description:
            "One CIDR per line. Cloud SQL drops connections from any IP not listed here. Use 0.0.0.0/0 to allow any IP (insecure — fine for dev). Leave empty to deny all public access. Click 'Detect my IP' to insert your current public IP.",
          placeholder: "1.2.3.4/32\n10.0.0.0/8",
          showWhen: { fieldKey: "publicIp", fieldValue: "true" },
          actions: [
            {
              id: "detect-my-ip",
              label: "Detect my IP",
              description: "Look up this machine's current public IP and append it as a /32 entry.",
            },
          ],
        },
        {
          key: "network",
          label: "VPC Network",
          kind: "resource-picker",
          required: false,
          description:
            "VPC network used for the private IP. Required when public IP is disabled; optional alongside public IP to enable both.",
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
    // The select submits "true" / "false"; treat anything other than an
    // explicit "false" as enabled so existing API consumers keep their
    // historical default (public IP on, matches the pre-toggle behaviour).
    const publicIpEnabled = fields["publicIp"] !== "false";
    const engine = engineInfoFromVersion(databaseVersion);

    if (!publicIpEnabled && !network) {
      throw new Error(
        "Cloud SQL: when public IP is disabled, a VPC network is required for the instance to be reachable.",
      );
    }

    const ipConfig: Record<string, unknown> = { ipv4Enabled: publicIpEnabled };
    if (network) {
      const projectsIdx = network.indexOf("projects/");
      ipConfig.privateNetwork =
        projectsIdx >= 0 ? network.slice(projectsIdx) : `projects/${p}/global/networks/${network}`;
    }
    if (publicIpEnabled) {
      const authorizedNetworks = parseAuthorizedNetworks(fields["authorizedNetworks"]);
      if (authorizedNetworks.length > 0) ipConfig.authorizedNetworks = authorizedNetworks;
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

/**
 * Parse the `authorizedNetworks` create-form field into the Cloud SQL API
 * shape `[{ name, value: "<cidr>" }, …]`. Splits on newlines and commas,
 * skips blanks, validates rough CIDR shape, and labels each entry so they're
 * identifiable in the GCP console.
 */
export function parseAuthorizedNetworks(
  raw: string | undefined,
): Array<{ name: string; value: string }> {
  if (!raw) return [];
  const cidrRe = /^[0-9a-fA-F:.]+\/\d{1,3}$/;
  const out: Array<{ name: string; value: string }> = [];
  for (const part of raw.split(/[\n,]+/)) {
    const cidr = part.trim();
    if (!cidr) continue;
    if (!cidrRe.test(cidr)) {
      throw new Error(
        `Invalid CIDR in Authorized Networks: "${cidr}". Use forms like 1.2.3.4/32 or 10.0.0.0/8.`,
      );
    }
    out.push({ name: `infrawrench-${out.length + 1}`, value: cidr });
  }
  return out;
}

/**
 * Look up this machine's current public IP via a public echo service. Used
 * by the Authorized Networks field's "Detect my IP" action so users don't
 * have to alt-tab to whatismyip.
 */
export async function detectMyPublicIp(existing: string | undefined): Promise<string> {
  const res = await fetch("https://api.ipify.org?format=text");
  if (!res.ok) throw new Error(`Couldn't detect public IP (${res.status})`);
  const ip = (await res.text()).trim();
  if (!/^[0-9.]+$/.test(ip) && !/^[0-9a-fA-F:]+$/.test(ip)) {
    throw new Error(`Public-IP service returned an unexpected value: ${ip}`);
  }
  const cidr = ip.includes(":") ? `${ip}/128` : `${ip}/32`;
  // Append to existing rather than replace, so users can build a list.
  const trimmed = (existing ?? "").replace(/\s+$/, "");
  if (!trimmed) return cidr;
  if (trimmed.split(/[\n,]/).some((s) => s.trim() === cidr)) return trimmed;
  return `${trimmed}\n${cidr}`;
}
