import { f, o, rt } from "@infrawrench/plugin-base";

export const KubernetesClusterResourceType = rt({
  name: "Kubernetes Cluster",
  id: "k8s-cluster",
  description: "A Kubernetes cluster — connects via kubeconfig (literal or from a DOKS cluster)",
  fields: [
    f("name", "Name"),
    f("kubeconfig", "Kubeconfig", {
      kind: "association",
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
    }),
  ],
  outputs: [o("serverVersion", "Server Version"), o("namespaces", "Namespaces (JSON array)")],
  iconKey: "kubernetes",
});
