import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const LogAnalyticsWorkspaceResourceType: ResourceTypeDefinition = {
  id: "azure-log-analytics",
  displayName: "Log Analytics Workspace",
  pluralDisplayName: "Log Analytics Workspaces",
  description: "An Azure Monitor Log Analytics workspace for collecting and analyzing telemetry",
  fields: [
    { key: "name", label: "Name", kind: "string", required: true },
    { key: "resourceGroup", label: "Resource Group", kind: "string", required: true },
    { key: "location", label: "Location", kind: "string", required: true },
    { key: "sku", label: "SKU", kind: "string", required: true },
    { key: "provisioningState", label: "Provisioning State", kind: "string", required: true },
    { key: "retentionInDays", label: "Retention (Days)", kind: "number", required: false },
    { key: "dailyQuotaGb", label: "Daily Quota (GB)", kind: "number", required: false },
  ],
  outputs: [
    { key: "customerId", label: "Workspace ID", sensitive: false },
    { key: "primarySharedKey", label: "Primary Key", sensitive: true },
  ],
  dashboardPinnable: true,
  iconKey: "pipeline",
  supportsCreate: true,
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
};
