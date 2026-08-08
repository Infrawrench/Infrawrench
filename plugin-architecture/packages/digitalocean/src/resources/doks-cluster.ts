import { f, o, rt } from "@infrawrench/plugin-base";

export const DOKSClusterResourceType = rt({
  name: "DOKS Cluster",
  id: "doks-cluster",
  description: "A managed Kubernetes cluster on DigitalOcean",
  fields: [
    f("name", "Name"),
    f("region", "Region", {
      kind: "enum",
      enumValues: [
        "nyc1",
        "nyc3",
        "sfo2",
        "sfo3",
        "ams3",
        "fra1",
        "sgp1",
        "lon1",
        "tor1",
        "blr1",
        "syd1",
      ],
    }),
    f("version", "Kubernetes Version", { description: "e.g. 1.31.1-do.4" }),
    f("nodePoolSize", "Node Pool Size", { description: "Node size slug, e.g. s-2vcpu-4gb" }),
    f("nodeCount", "Node Count", { kind: "number" }),
  ],
  outputs: [
    o("kubeconfig", "Kubeconfig", {
      sensitive: true,
      hidden: true,
      description: "Full kubeconfig YAML for connecting to this cluster",
    }),
    o("clusterEndpoint", "Cluster Endpoint", {
      hidden: true,
      description: "HTTPS endpoint for the Kubernetes API server",
    }),
    o("nodeHourlyRates", "Node Hourly Rates", {
      hidden: true,
      description:
        "JSON map of node instance type to hourly price, handed to the Kubernetes peer so it can derive per-namespace and per-workload cost. Empty when no price is available.",
    }),
  ],
  parentTypeId: "project",
  showInSidebar: true,
  iconKey: "kubernetes",
  supportsCreate: true,
  supportsMetrics: true,
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
      id: "doks-kubeconfig",
      displayName: "DOKS Kubeconfig",
      description: "Kubeconfig for kubectl access to this DOKS cluster",
      entries: [
        { envKey: "KUBECONFIG_DATA", outputKey: "kubeconfig" },
        { envKey: "KUBE_API_ENDPOINT", outputKey: "clusterEndpoint" },
      ],
    },
  ],
});
