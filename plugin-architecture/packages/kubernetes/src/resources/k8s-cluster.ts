import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const KubernetesClusterResourceType: ResourceTypeDefinition = {
  id: "k8s-cluster",
  displayName: "Kubernetes Cluster",
  pluralDisplayName: "Kubernetes Clusters",
  description: "A Kubernetes cluster — connects via kubeconfig (literal or from a DOKS cluster)",
  fields: [
    { key: "name", label: "Name", kind: "string", required: true },
    {
      key: "kubeconfig",
      label: "Kubeconfig",
      kind: "association",
      required: true,
      description:
        "Where to get the kubeconfig from. Choose a DOKS cluster or paste a literal kubeconfig.",
      allowLiteral: true,
      resolvableOutputKeys: ["kubeconfig"],
      resolvableFrom: [
        {
          pluginId: "digitalocean",
          resourceTypeId: "doks-cluster",
          outputKey: "kubeconfig",
        },
      ],
    },
  ],
  outputs: [
    { key: "serverVersion", label: "Server Version", sensitive: false },
    { key: "namespaces", label: "Namespaces (JSON array)", sensitive: false },
  ],
  dashboardPinnable: true,
  iconKey: "kubernetes",
};
