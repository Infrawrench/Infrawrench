import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const CloudSchedulerJobResourceType: ResourceTypeDefinition = {
  id: "cloud-scheduler-job",
  displayName: "Cloud Scheduler Job",
  pluralDisplayName: "Cloud Scheduler Jobs",
  description: "A Google Cloud Scheduler cron job",
  fields: [
    { key: "name", label: "Name", kind: "string", required: true },
    { key: "region", label: "Region", kind: "string", required: false },
    { key: "schedule", label: "Schedule", kind: "string", required: false },
    { key: "timeZone", label: "Time Zone", kind: "string", required: false },
    { key: "state", label: "State", kind: "string", required: false },
    { key: "targetType", label: "Target Type", kind: "string", required: false },
    { key: "targetUri", label: "Target URI", kind: "string", required: false },
    { key: "lastAttemptTime", label: "Last Run", kind: "string", required: false },
    { key: "scheduleTime", label: "Next Run", kind: "string", required: false },
  ],
  outputs: [],
  dashboardPinnable: true,
};
