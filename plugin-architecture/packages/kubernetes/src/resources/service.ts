import { f, o, rt } from "@infrawrench/plugin-base";

export const ServiceResourceType = rt({
  name: "Service",
  pinnable: false,
  id: "k8s-service",
  description: "A Kubernetes Service — exposes pods via a stable endpoint",
  fields: [
    f("name", "Name"),
    f("namespace", "Namespace"),
    f("qualifiedName", "Qualified Name", {
      required: false,
      description: "namespace/name — how Ingresses in this namespace reference this Service",
    }),
    f("type", "Type", { required: false }),
    f("clusterIP", "Cluster IP", { required: false }),
    f("externalIP", "External IP", {
      required: false,
      description: "The LoadBalancer's provisioned address, once one exists",
    }),
    f("ports", "Ports", { required: false }),
  ],
  outputs: [
    o("serviceName", "Service Name", {
      description:
        "The Service's name — used by Ingresses and StatefulSets to reference this Service",
    }),
  ],
  dependsOn: [
    // Namespaces report no external id; their identity is the bare name.
    {
      fieldKey: "namespace",
      targetTypeId: "k8s-namespace",
      targetKey: "name",
      label: "in namespace",
    },
  ],
  parentTypeId: "k8s-namespace",
  supportsCreate: true,
});
