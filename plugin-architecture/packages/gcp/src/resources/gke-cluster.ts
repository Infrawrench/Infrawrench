import { f, o, rt } from "@infrawrench/plugin-base";

export const GkeClusterResourceType = rt({
  name: "GKE Cluster",
  id: "gke-cluster",
  description: "A Google Kubernetes Engine cluster",
  fields: [
    f("name", "Name"),
    f("location", "Location"),
    f("version", "Kubernetes Version", { required: false }),
    f("machineType", "Machine Type", { required: false }),
    f("diskSizeGb", "Disk Size (GB)", { kind: "number", required: false }),
    f("nodeCount", "Node Count", { kind: "number", required: false }),
    f("serviceAccount", "Node Service Account", {
      required: false,
      description:
        "Service account email the node VMs run as; the Compute Engine default when omitted",
    }),
    f("status", "Status", { required: false }),
    f("network", "VPC Network", {
      kind: "association",
      required: false,
      description: "VPC network to deploy the cluster in",
      allowLiteral: true,
      resolvableOutputKeys: ["selfLink"],
      resolvableFrom: [
        {
          pluginId: "gcp",
          resourceTypeId: "vpc-network",
          outputKey: "selfLink",
        },
      ],
    }),
  ],
  outputs: [
    o("clusterEndpoint", "Cluster Endpoint", { hidden: true }),
    o("kubeconfig", "Kubeconfig", {
      sensitive: true,
      hidden: true,
      description: "Full kubeconfig YAML for kubectl access",
    }),
  ],
  supportsCreate: true,
  supportsMetrics: true,
  peerIntegrations: [
    {
      pluginId: "kubernetes",
      credentialMappings: [{ outputKey: "kubeconfig", credentialKey: "kubeconfig" }],
      tabLabel: "Kubernetes",
    },
  ],
});
