import { f, rt } from "@infrawrench/plugin-base";

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
    f("cronJob", "CronJob", {
      required: false,
      description: "The CronJob that scheduled this Job, from its owner reference",
    }),
  ],
  outputs: [],
  dependsOn: [
    // Namespaces report no external id; their identity is the bare name.
    {
      fieldKey: "namespace",
      targetTypeId: "k8s-namespace",
      targetKey: "name",
      label: "in namespace",
    },
    // The owner reference carries only the bare CronJob name, which repeats
    // across namespaces — compose the namespace back on before matching.
    {
      fieldKey: "cronJob",
      targetTypeId: "k8s-cronjob",
      targetKey: "qualifiedName",
      matchTemplate: "{namespace}/{cronJob}",
      label: "run by",
    },
  ],
  parentTypeId: "k8s-namespace",
  supportsCreate: true,
});
