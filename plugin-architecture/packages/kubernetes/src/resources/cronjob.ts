import { f, rt } from "@infrawrench/plugin-base";

export const CronJobResourceType = rt({
  name: "CronJob",
  pinnable: false,
  id: "k8s-cronjob",
  description: "A Kubernetes CronJob — runs Jobs on a schedule",
  fields: [
    f("name", "Name"),
    f("namespace", "Namespace"),
    f("qualifiedName", "Qualified Name", {
      required: false,
      description: "namespace/name — how the Jobs it spawns reference this CronJob",
    }),
    f("schedule", "Schedule", { required: false }),
    f("suspended", "Suspended", { required: false }),
    f("lastSchedule", "Last Schedule", { required: false }),
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
  ],
  parentTypeId: "k8s-namespace",
  supportsCreate: true,
});
