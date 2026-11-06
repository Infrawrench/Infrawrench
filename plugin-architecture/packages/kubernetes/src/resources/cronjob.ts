import { f, rt } from "@infrawrench/plugin-base";

export const CronJobResourceType = rt({
  name: "CronJob",
  pinnable: false,
  id: "k8s-cronjob",
  iconKey: "schedule",
  description: "A Kubernetes CronJob that runs Jobs on a schedule",
  fields: [
    f("name", "Name"),
    f("namespace", "Namespace", { showcase: true }),
    f("qualifiedName", "Qualified Name", {
      required: false,
      description: "namespace/name, as referenced by the Jobs it spawns",
    }),
    f("schedule", "Schedule", { showcase: true, required: false }),
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
