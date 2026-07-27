import { f, rt } from "@infrawrench/plugin-base";

export const CronJobResourceType = rt({
  name: "CronJob",
  pinnable: false,
  id: "k8s-cronjob",
  description: "A Kubernetes CronJob — runs Jobs on a schedule",
  fields: [
    f("name", "Name"),
    f("namespace", "Namespace"),
    f("schedule", "Schedule", { required: false }),
    f("suspended", "Suspended", { required: false }),
    f("lastSchedule", "Last Schedule", { required: false }),
  ],
  outputs: [],
  parentTypeId: "k8s-namespace",
  supportsCreate: true,
});
