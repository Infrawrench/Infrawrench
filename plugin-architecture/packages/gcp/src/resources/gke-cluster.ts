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
    f("networkName", "Attached Network", {
      required: false,
      description: "Name of the VPC network the cluster is connected to",
    }),
    f("subnetwork", "Subnet", {
      required: false,
      description: "Subnet the cluster is connected to, as region/name",
    }),
  ],
  // `serviceAccount` is a node service account email, matching that type's
  // external id — unless the node pool left it as the literal "default", which
  // names no synced resource and so produces no edge. `subnetwork` is scoped by
  // the cluster's region to line up with a subnet's external id.
  dependsOn: [
    {
      fieldKey: "networkName",
      targetTypeId: "vpc-network",
      targetKey: "name",
      label: "in network",
    },
    { fieldKey: "subnetwork", targetTypeId: "subnet", label: "in subnet" },
    { fieldKey: "serviceAccount", targetTypeId: "gcp-service-account", label: "nodes run as" },
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
