import { f, rt } from "@infrawrench/plugin-base";

export const CloudSchedulerJobResourceType = rt({
  name: "Cloud Scheduler Job",
  id: "cloud-scheduler-job",
  description: "A Google Cloud Scheduler cron job",
  fields: [
    f("name", "Name"),
    f("region", "Region", { required: false }),
    f("schedule", "Schedule", { required: false }),
    f("timeZone", "Time Zone", { required: false }),
    f("state", "State", { required: false }),
    f("targetType", "Target Type", { required: false }),
    f("targetUri", "Target URI", { required: false }),
    f("lastAttemptTime", "Last Run", { required: false }),
    f("scheduleTime", "Next Run", { required: false }),
  ],
  outputs: [],
  supportsCreate: true,
});
