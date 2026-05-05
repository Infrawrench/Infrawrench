import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const CronJobResourceType: ResourceTypeDefinition = {
  id: "k8s-cronjob",
  displayName: "CronJob",
  pluralDisplayName: "CronJobs",
  description: "A Kubernetes CronJob — runs Jobs on a schedule",
  fields: [
    { key: "name", label: "Name", kind: "string", required: true },
    { key: "namespace", label: "Namespace", kind: "string", required: true },
    { key: "schedule", label: "Schedule", kind: "string", required: false },
    { key: "suspended", label: "Suspended", kind: "string", required: false },
    { key: "lastSchedule", label: "Last Schedule", kind: "string", required: false },
  ],
  outputs: [],
  parentTypeId: "k8s-namespace",
  dashboardPinnable: false,
  supportsCreate: true,
};
