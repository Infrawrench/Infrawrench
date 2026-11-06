import { f, rt } from "@infrawrench/plugin-base";

export const CloudSchedulerJobResourceType = rt({
  name: "Cloud Scheduler Job",
  id: "cloud-scheduler-job",
  iconKey: "schedule",
  description: "A Google Cloud Scheduler cron job",
  fields: [
    f("name", "Name"),
    f("region", "Region", { showcase: true, required: false }),
    f("schedule", "Schedule", { showcase: true, required: false }),
    f("timeZone", "Time Zone", { required: false }),
    f("state", "State", { showcase: true, required: false }),
    f("targetType", "Target Type", { required: false }),
    f("targetUri", "Target URI", { required: false }),
    f("lastAttemptTime", "Last Run", { required: false }),
    f("scheduleTime", "Next Run", { required: false }),
  ],
  outputs: [],
  // targetUri holds the short topic id for Pub/Sub jobs; HTTP and App Engine
  // jobs store a URL or a path, neither of which can name a topic.
  dependsOn: [
    {
      fieldKey: "targetUri",
      targetTypeId: "pubsub-topic",
      targetKey: "name",
      label: "publishes to",
    },
  ],
  supportsCreate: true,
});
