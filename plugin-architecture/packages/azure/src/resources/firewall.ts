import { f, o, rt } from "@infrawrench/plugin-base";

export const FirewallResourceType = rt({
  name: "Firewall",
  id: "azure-firewall",
  description: "An Azure Firewall for network traffic filtering and protection",
  fields: [
    f("name", "Name"),
    f("resourceGroup", "Resource Group", { showcase: true }),
    f("location", "Location", { showcase: true }),
    f("sku", "SKU"),
    f("tier", "Tier", { showcase: true }),
    f("provisioningState", "Provisioning State", { showcase: true }),
    f("threatIntelMode", "Threat Intel Mode", { required: false }),
  ],
  outputs: [o("privateIp", "Private IP")],
  dependsOn: [
    { fieldKey: "resourceGroup", targetTypeId: "azure-resource-group", label: "in resource group" },
  ],
  supportsMetrics: true,
  // `fetchAzureMetricSeries` labels a series with Azure Monitor's display name:
  // "SNAT port utilization" for `SNATPortUtilization` ("Percentage of outbound SNAT
  // ports currently in use", Percent) at
  // https://learn.microsoft.com/azure/azure-monitor/reference/supported-metrics/microsoft-network-azurefirewalls-metrics
  // (read 2026-11-23)
  capacityMetrics: [
    {
      seriesLabel: "SNAT port utilization",
      limit: { constant: 100 },
      unit: "%",
      label: "SNAT ports",
    },
  ],
  iconKey: "firewall",
});
