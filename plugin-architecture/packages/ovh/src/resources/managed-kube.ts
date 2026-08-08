import { f, o, rt } from "@infrawrench/plugin-base";

const REGIONS = [
  "GRA5",
  "GRA7",
  "GRA9",
  "GRA11",
  "SBG5",
  "BHS5",
  "WAW1",
  "DE1",
  "UK1",
  "SGP1",
  "SYD1",
];

export const ManagedKubeResourceType = rt({
  id: "managed-kube",
  name: "Managed Kubernetes",
  plural: "Managed Kubernetes",
  description: "An OVHcloud Managed Kubernetes Service cluster",
  fields: [
    f("name", "Name"),
    f("region", "Region", { kind: "enum", enumValues: REGIONS }),
    f("version", "Kubernetes Version", { description: "e.g. 1.30" }),
    f("status", "Status", { required: false }),
    f("flavor", "Flavor", {
      required: false,
      description: "Flavor of the first node pool, e.g. b3-8",
    }),
    f("nodeCount", "Node Count", { kind: "number", required: false }),
    f("nodePoolCount", "Node Pools", { kind: "number", required: false }),
    f("nodesUrl", "Nodes URL", { required: false }),
    f("privateNetworkId", "Private Network", {
      required: false,
      description: "OpenStack ID of the private network the cluster's nodes sit in, if attached",
    }),
    f("nodesSubnetId", "Nodes Subnet", {
      required: false,
      description: "OpenStack subnet ID the cluster nodes use",
    }),
    f("loadBalancersSubnetId", "Load Balancers Subnet", {
      required: false,
      description: "OpenStack subnet ID the cluster's load balancers use",
    }),
  ],
  outputs: [
    o("kubeconfig", "Kubeconfig", {
      sensitive: true,
      hidden: true,
      description: "Full kubeconfig YAML for connecting to this cluster",
    }),
    o("clusterUrl", "Cluster URL", {
      hidden: true,
      description: "HTTPS endpoint for the Kubernetes API server",
    }),
    o("nodeHourlyRates", "Node Hourly Rates", {
      hidden: true,
      description:
        "JSON map of node instance type to hourly price, handed to the Kubernetes peer so it can derive per-namespace and per-workload cost. Empty when no price is available.",
    }),
  ],
  // `privateNetworkId` is the network's OpenStack id — `cloud.kube.Cluster` in
  // https://eu.api.ovh.com/1.0/cloud.json documents it as "OpenStack private
  // network ID that the cluster will use", and OVH's own control panel resolves
  // it via `regions[].openstackId` (pci-kubernetes `getPrivateNetworkName`). So
  // it matches on `openstackIds`, not on the `pn-…` externalId — unlike an
  // instance's `networkIds`, which does carry the `pn-…` form.
  dependsOn: [
    {
      fieldKey: "privateNetworkId",
      targetTypeId: "private-network",
      targetKey: "openstackIds",
      label: "runs in",
    },
  ],
  iconKey: "kubernetes",
  supportsCreate: true,
  peerIntegrations: [
    {
      pluginId: "kubernetes",
      credentialMappings: [
        { outputKey: "kubeconfig", credentialKey: "kubeconfig" },
        // What this cluster's nodes cost per hour. The kubernetes plugin has
        // no way to know — the money is on THIS account — so it arrives the
        // same way the kubeconfig does. Resolves to "" when we have no price,
        // which the peer reads as "show capacity without money".
        { outputKey: "nodeHourlyRates", credentialKey: "nodeHourlyRates" },
      ],
      tabLabel: "Kubernetes",
      // Merge the peer's derived cost/efficiency series into THIS resource's
      // own Metrics tab, so cluster spend sits next to the provider's node
      // metrics instead of being buried one tab deeper.
      exposeMetricsToParent: true,
    },
  ],
  secretExportTemplates: [
    {
      id: "ovh-kubeconfig",
      displayName: "OVH Kubeconfig",
      description: "Kubeconfig for kubectl access to this OVH Managed Kubernetes cluster",
      entries: [
        { envKey: "KUBECONFIG_DATA", outputKey: "kubeconfig" },
        { envKey: "KUBE_API_ENDPOINT", outputKey: "clusterUrl" },
      ],
    },
  ],
});
