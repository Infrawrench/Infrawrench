import { f, o, rt } from "@infrawrench/plugin-base";

export const OctaviaLoadBalancerResourceType = rt({
  id: "octavia-load-balancer",
  name: "Public Cloud Load Balancer",
  description:
    "An OVHcloud Public Cloud Load Balancer (OpenStack Octavia), the regional load balancer behind Managed Kubernetes services",
  fields: [
    f("name", "Name"),
    f("region", "Region", { editable: false }),
    f("flavor", "Size", {
      description:
        "Flavor name, e.g. small, medium, large, xl. Changing it resizes the load balancer",
    }),
    f("provisioningStatus", "Provisioning", {
      kind: "enum",
      required: false,
      enumValues: ["active", "creating", "deleted", "deleting", "error", "updating"],
      editable: false,
    }),
    f("operatingStatus", "Operating Status", {
      kind: "enum",
      required: false,
      enumValues: ["degraded", "draining", "error", "noMonitor", "offline", "online"],
      editable: false,
    }),
    f("vipAddress", "Private VIP", { required: false, editable: false }),
    f("floatingIp", "Public IP", { required: false, editable: false }),
    f("vipNetworkId", "Network", {
      required: false,
      description: "OpenStack ID of the network the VIP sits in",
      editable: false,
    }),
  ],
  outputs: [o("vipAddress", "Private VIP"), o("floatingIp", "Public IP")],
  // `vipNetworkId` is the OpenStack network id, matched against a private
  // network's per-region `openstackIds`.
  dependsOn: [
    {
      fieldKey: "vipNetworkId",
      targetTypeId: "private-network",
      targetKey: "openstackIds",
      label: "in network",
    },
  ],
  // Edit = name and size (`PUT .../loadbalancer/{id}` with a flavor id).
  supportsUpdate: true,
  iconKey: "load-balancer",
});
