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
  ],
  // `privateNetworkId` is the network's OpenStack id (the value OVH's own
  // tooling feeds it from `regions[].openstackid`), so it matches the private
  // network on `openstackIds` rather than on its `pn-…` externalId.
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
      credentialMappings: [{ outputKey: "kubeconfig", credentialKey: "kubeconfig" }],
      tabLabel: "Kubernetes",
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
