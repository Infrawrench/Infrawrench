import { f, o, rt } from "@infrawrench/plugin-base";

export const JobResourceType = rt({
  name: "Job",
  pinnable: false,
  id: "k8s-job",
  description: "A Kubernetes Job — runs a pod to completion",
  fields: [
    f("name", "Name"),
    f("namespace", "Namespace"),
    f("completions", "Completions", { required: false }),
    f("status", "Status", { required: false }),
    f("image", "Image", { required: false }),
  ],
  outputs: [],
  parentTypeId: "k8s-namespace",
  supportsCreate: true,
});
