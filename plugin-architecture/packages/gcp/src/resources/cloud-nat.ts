import { f, rt } from "@infrawrench/plugin-base";

export const CloudNatResourceType = rt({
  name: "Cloud NAT",
  pinnable: false,
  id: "cloud-nat",
  iconKey: "route",
  description: "A Google Cloud NAT gateway configuration",
  fields: [
    f("name", "Name"),
    f("region", "Region", { showcase: true }),
    f("router", "Router"),
    f("natIpAllocateOption", "IP Allocation", { required: false }),
    f("sourceSubnetworkIpRangesToNat", "Subnet IP Ranges", { required: false }),
    f("portsPerVm", "Ports per VM", {
      kind: "number",
      required: false,
      editable: false,
      description:
        "Source ports each VM gets (the maximum under dynamic port allocation), which caps its connections to any one destination",
    }),
    f("status", "Status", { showcase: true, required: false }),
  ],
  outputs: [],
  dependsOn: [
    { fieldKey: "router", targetTypeId: "cloud-router", targetKey: "name", label: "on router" },
  ],
  supportsCreate: true,
  supportsMetrics: true,
  // `router.googleapis.com/nat/port_usage` ("Maximum number of connections
  // from VM to a single internet endpoint (IP:port)"), worst VM, against the
  // ports each VM is allocated; at the limit new connections are dropped:
  // https://docs.cloud.google.com/monitoring/api/metrics_gcp_p_z, read 2026-11-23
  capacityMetrics: [
    {
      seriesLabel: "Port usage (max per VM)",
      limit: { field: "portsPerVm" },
      unit: "ports",
      label: "NAT Ports per VM",
    },
  ],
  attachTargets: [
    {
      pluginId: "gcp",
      resourceTypeId: "subnet",
      matchField: "region",
      verb: "Apply NAT",
    },
  ],
});
