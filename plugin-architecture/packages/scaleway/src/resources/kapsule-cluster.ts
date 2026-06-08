import { f, o, rt } from "@infrawrench/plugin-base";

const REGIONS = ["fr-par", "nl-ams", "pl-waw"];

export const KapsuleClusterResourceType = rt({
  id: "kapsule-cluster",
  name: "Kapsule Cluster",
  description: "A managed Kubernetes cluster on Scaleway",
  fields: [
    f("name", "Name"),
    f("region", "Region", { kind: "enum", enumValues: REGIONS }),
    f("version", "Kubernetes Version", { description: "e.g. 1.30.2" }),
    f("nodeType", "Node Type", { description: "Node commercial type, e.g. DEV1-M, GP1-S" }),
    f("nodeCount", "Node Count", { kind: "number" }),
    f("diskSizeGb", "Disk Size (GB)", {
      kind: "number",
      required: false,
      description: "Root volume size of the first node pool",
    }),
    f("status", "Status", { required: false }),
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
  iconKey: "kubernetes",
  supportsCreate: true,
  supportsMetrics: true,
  peerIntegrations: [
    {
      pluginId: "kubernetes",
      credentialMappings: [{ outputKey: "kubeconfig", credentialKey: "kubeconfig" }],
      tabLabel: "Kubernetes",
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
