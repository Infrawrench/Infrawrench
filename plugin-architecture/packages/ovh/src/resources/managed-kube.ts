import { f, o, rt } from "@infrawrench/plugin-base";

export const ManagedKubeResourceType = rt({
  id: "managed-kube",
  // Nodes are Public Cloud instances in their own right: shown here, never
  // summed twice.
  carbon: {
    role: "aggregate",
    regionFieldKey: "region",
    vcpus: { from: "size", sizeFieldKey: "flavor" },
    countFieldKey: "nodeCount",
  },
  name: "Managed Kubernetes",
  plural: "Managed Kubernetes",
  description: "An OVHcloud Managed Kubernetes Service cluster",
  fields: [
    f("name", "Name"),
    f("region", "Region", {
      description: "OpenStack region, e.g. GRA11, EU-WEST-PAR",
      editable: false,
    }),
    f("version", "Kubernetes Version", {
      description: "e.g. 1.33. Use the upgrade actions to move to a newer version",
      editable: false,
    }),
    f("status", "Status", { required: false, editable: false }),
    f("flavor", "Flavor", {
      required: false,
      description: "Flavor of the first node pool, e.g. b3-8",
      editable: false,
    }),
    f("nodeCount", "Node Count", {
      kind: "number",
      required: false,
      description: "Total desired nodes. Editing it resizes the first node pool",
    }),
    f("nodePoolCount", "Node Pools", { kind: "number", required: false, editable: false }),
    f("updatePolicy", "Update Policy", {
      kind: "enum",
      required: false,
      enumValues: ["ALWAYS_UPDATE", "MINIMAL_DOWNTIME", "NEVER_UPDATE"],
      description: "When OVH applies security patches and minor upgrades",
    }),
    f("isUpToDate", "Up To Date", { kind: "boolean", required: false, editable: false }),
    f("nextUpgradeVersions", "Upgrade Available To", { required: false, editable: false }),
    f("plan", "Plan", { required: false, editable: false }),
    f("etcdUsagePercent", "etcd Usage (%)", { kind: "number", required: false, editable: false }),
    f("nodesUrl", "Nodes URL", { required: false, editable: false }),
    f("privateNetworkId", "Private Network", {
      required: false,
      description: "OpenStack ID of the private network the cluster's nodes sit in, if attached",
      editable: false,
    }),
    f("nodesSubnetId", "Nodes Subnet", {
      required: false,
      description: "OpenStack subnet ID the cluster nodes use",
      editable: false,
    }),
    f("loadBalancersSubnetId", "Load Balancers Subnet", {
      required: false,
      editable: false,
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
        "JSON map of node instance type to hourly price, used for per-namespace and per-workload cost. Empty when no price is available.",
    }),
  ],
  // `privateNetworkId` is the network's OpenStack id: `cloud.kube.Cluster` in
  // https://eu.api.ovh.com/1.0/cloud.json documents it as "OpenStack private
  // network ID that the cluster will use", and OVH's own control panel resolves
  // it via `regions[].openstackId` (pci-kubernetes `getPrivateNetworkName`). So
  // it matches on `openstackIds`, not on the `pn-…` externalId: unlike an
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
  // Edit = name and update policy (`PUT /kube/{id}`) and the first pool's
  // size (`PUT /nodepool/{id}`).
  supportsUpdate: true,
  peerIntegrations: [
    {
      pluginId: "kubernetes",
      credentialMappings: [
        { outputKey: "kubeconfig", credentialKey: "kubeconfig" },
        // What this cluster's nodes cost per hour. The kubernetes plugin has
        // no way to know (the money is on THIS account) so it arrives the
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
