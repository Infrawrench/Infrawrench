import { f, rt } from "@infrawrench/plugin-base";

export const NodeResourceType = rt({
  name: "Node",
  pinnable: false,
  id: "k8s-node",
  description: "A Kubernetes worker node — what pods actually schedule onto",
  fields: [
    f("name", "Name"),
    f("ready", "Ready", { required: false }),
    f("unschedulable", "Cordoned", { required: false }),
    f("instanceType", "Instance Type", { required: false }),
    f("zone", "Zone", { required: false }),
    f("version", "Kubelet Version", { required: false }),
    f("allocatableCpu", "Allocatable CPU", { required: false }),
    f("allocatableMemory", "Allocatable Memory", { required: false }),
  ],
  outputs: [],
  supportsCreate: false,
  supportsDelete: false,
});
