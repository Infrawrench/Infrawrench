import { f, o, rt } from "@infrawrench/plugin-base";

export const NeonProjectResourceType = rt({
  name: "Project",
  id: "neon-project",
  description: "A Neon project, containing branches, endpoints and databases",
  fields: [
    f("name", "Name"),
    f("region", "Region", { showcase: true, required: false, editable: false }),
    f("pgVersion", "PostgreSQL Version", { required: false, editable: false }),
    f("orgId", "Organization", { required: false, editable: false }),
    f("proxyHost", "Proxy Host", { required: false, editable: false }),
    f("computeLastActiveAt", "Compute Last Active", { required: false, editable: false }),
    f("historyRetentionSeconds", "Restore Window (s)", {
      kind: "number",
      required: false,
      description:
        "How far back branches can be restored, in seconds (0 to 2592000). Plan limits: Free 6 h, Launch 7 days, Scale 30 days.",
    }),
    f("createdAt", "Created At", { showcase: true, required: false, editable: false }),
    // Consumption this billing period, from GET /projects/{project_id}
    // (`compute_time_seconds`, `data_transfer_bytes`, `active_time_seconds`,
    // `written_data_bytes`, `consumption_period_start` / `_end`,
    // `owner.subscription_type`; Neon API reference, read 2026-11-23). Neon calls
    // them approximate and not for billing; they reset each period.
    f("plan", "Plan", { required: false, editable: false }),
    f("consumptionPeriodStart", "Billing Period Start", { required: false, editable: false }),
    f("consumptionPeriodEnd", "Billing Period End", { required: false, editable: false }),
    // The Free plan includes 100 CU-hours per project each month and suspends
    // compute past it; paid plans bill per CU-hour with no allowance
    // (https://neon.com/docs/introduction/plans, read 2026-11-23). `free_v3` is
    // the current Free plan's `subscription_type`.
    f("computeCuHours", "Compute Used (CU-hours)", {
      kind: "number",
      required: false,
      editable: false,
      usage: {
        limit: { plan: { field: "plan", allowances: { free_v3: 100 } } },
        unit: "CU-hours",
        cycle: {
          period: "monthly",
          startField: "consumptionPeriodStart",
          endField: "consumptionPeriodEnd",
        },
        label: "Compute",
      },
    }),
    // 5 GB (decimal, 10^9 bytes) of public network transfer per project each
    // month on Free, shared with Object Storage and Functions, which
    // `data_transfer_bytes` (Postgres egress through the proxy) does not count
    // (same page, and "Usage and cost calculations", read 2026-11-23).
    f("dataTransferBytes", "Data Transfer", {
      kind: "number",
      required: false,
      editable: false,
      usage: {
        limit: { plan: { field: "plan", allowances: { free_v3: 5_000_000_000 } } },
        unit: "bytes",
        cycle: {
          period: "monthly",
          startField: "consumptionPeriodStart",
          endField: "consumptionPeriodEnd",
        },
        label: "Network transfer",
      },
    }),
    // Against the project's own quotas (`settings.quota`, `ProjectQuota`): past
    // one, Neon suspends every compute in the project until the next period
    // (https://neon.com/docs/guides/consumption-limits, read 2026-11-23). Unset
    // or 0 is no limit, and the lister leaves the quota out.
    f("activeTimeSeconds", "Active Time (s)", {
      kind: "number",
      required: false,
      editable: false,
      usage: {
        limit: { field: "activeTimeQuotaSeconds" },
        unit: "seconds",
        cycle: {
          period: "monthly",
          startField: "consumptionPeriodStart",
          endField: "consumptionPeriodEnd",
        },
        label: "Active time quota",
      },
    }),
    f("activeTimeQuotaSeconds", "Active Time Quota (s)", {
      kind: "number",
      required: false,
      editable: false,
    }),
    f("writtenDataBytes", "Data Written", {
      kind: "number",
      required: false,
      editable: false,
      usage: {
        limit: { field: "writtenDataQuotaBytes" },
        unit: "bytes",
        cycle: {
          period: "monthly",
          startField: "consumptionPeriodStart",
          endField: "consumptionPeriodEnd",
        },
        label: "Written data quota",
      },
    }),
    f("writtenDataQuotaBytes", "Data Written Quota", {
      kind: "number",
      required: false,
      editable: false,
    }),
  ],
  outputs: [
    o("projectId", "Project ID"),
    o("region", "Region"),
    o("pgVersion", "PostgreSQL Version"),
    o("connectionString", "Connection String (default database)", { sensitive: true }),
  ],
  supportsCreate: true,
  supportsUpdate: true,
  supportsMetrics: true,
  iconKey: "project",
  peerIntegrations: [
    {
      pluginId: "postgres",
      credentialMappings: [{ outputKey: "connectionString", credentialKey: "connectionString" }],
      tabLabel: "PostgreSQL",
    },
  ],
  secretExportTemplates: [
    {
      id: "connection-url",
      displayName: "Connection URL",
      description: "DATABASE_URL for the default database on the primary branch",
      entries: [{ envKey: "DATABASE_URL", outputKey: "connectionString" }],
    },
  ],
});
