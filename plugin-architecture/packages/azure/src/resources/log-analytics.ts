import { f, o, rt } from "@infrawrench/plugin-base";

export const LogAnalyticsWorkspaceResourceType = rt({
  name: "Log Analytics Workspace",
  id: "azure-log-analytics",
  description: "An Azure Monitor Log Analytics workspace for collecting and analyzing telemetry",
  fields: [
    f("name", "Name"),
    f("resourceGroup", "Resource Group"),
    f("location", "Location"),
    f("sku", "SKU"),
    f("provisioningState", "Provisioning State"),
    f("retentionInDays", "Retention (Days)", { kind: "number", required: false }),
    f("dailyQuotaGb", "Daily Quota (GB)", { kind: "number", required: false }),
  ],
  outputs: [
    o("customerId", "Workspace ID"),
    o("primarySharedKey", "Primary Key", { sensitive: true }),
  ],
  dependsOn: [
    { fieldKey: "resourceGroup", targetTypeId: "azure-resource-group", label: "in resource group" },
  ],
  iconKey: "pipeline",
  supportsCreate: true,
  supportsMetrics: true,
  secretExportTemplates: [
    {
      id: "log-analytics-connection",
      displayName: "Log Analytics Connection",
      description: "Azure Log Analytics workspace connection details",
      entries: [
        { envKey: "LOG_ANALYTICS_WORKSPACE_ID", outputKey: "customerId" },
        { envKey: "LOG_ANALYTICS_PRIMARY_KEY", outputKey: "primarySharedKey" },
      ],
    },
  ],
});
