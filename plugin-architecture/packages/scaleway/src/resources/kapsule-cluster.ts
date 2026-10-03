import { f, o, rt } from "@infrawrench/plugin-base";
import { SCW_REGIONS as REGIONS } from "../locations.js";

export const KapsuleClusterResourceType = rt({
  id: "kapsule-cluster",
  name: "Kapsule Cluster",
  description: "A managed Kubernetes cluster on Scaleway",
  fields: [
    f("name", "Name"),
    f("region", "Region", { kind: "enum", enumValues: REGIONS, editable: false }),
    f("version", "Kubernetes Version", {
      description:
        "e.g. 1.33.4. Changing it upgrades the control plane and every pool, one minor version at a time",
    }),
    f("nodeType", "Node Type", {
      description: "Node commercial type of the first pool, e.g. DEV1-M, POP2-2C-8G",
      editable: false,
    }),
    f("nodeCount", "Node Count", {
      kind: "number",
      description: "Total nodes. Editing it resizes the first pool",
    }),
    f("upgradeAvailable", "Upgrade Available", {
      kind: "boolean",
      required: false,
      editable: false,
    }),
    f("poolCount", "Pools", { kind: "number", required: false, editable: false }),
    f("cni", "CNI", { required: false, editable: false }),
    f("diskSizeGb", "Disk Size (GB)", {
      kind: "number",
      required: false,
      description: "Root volume size of the first node pool",
      editable: false,
    }),
    f("status", "Status", { required: false, editable: false }),
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
  iconKey: "kubernetes",
  supportsCreate: true,
  // Edit = version upgrade (`POST /upgrade` with upgrade_pools) and the
  // first pool's size (`PATCH /pools/{id}`).
  supportsUpdate: true,
  supportsMetrics: true,
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
      id: "kapsule-kubeconfig",
      displayName: "Kapsule Kubeconfig",
      description: "Kubeconfig for kubectl access to this Kapsule cluster",
      entries: [
        { envKey: "KUBECONFIG_DATA", outputKey: "kubeconfig" },
        { envKey: "KUBE_API_ENDPOINT", outputKey: "clusterUrl" },
      ],
    },
  ],
});
