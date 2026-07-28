import { f, o, rt } from "@infrawrench/plugin-base";

/**
 * The API key itself, as a single navigable resource. Gladia has no account,
 * usage or quota endpoint, so this resource carries what can be honestly
 * derived from the transcription history plus the Speech tab.
 */
export const WorkspaceResourceType = rt({
  name: "Workspace",
  plural: "Workspace",
  id: "workspace",
  description: "The Gladia API key, its recent transcription activity, and the Speech playground",
  fields: [
    f("endpoint", "API Endpoint", { required: false }),
    f("recentJobs", "Recent Jobs Sampled", { kind: "number", required: false }),
    f("doneJobs", "Completed", { kind: "number", required: false }),
    f("erroredJobs", "Errored", { kind: "number", required: false }),
    f("runningJobs", "Queued or Processing", { kind: "number", required: false }),
    f("sampledBillingTime", "Sampled Billed Time (s)", { kind: "number", required: false }),
    f("sampledAudioDuration", "Sampled Audio Duration (s)", { kind: "number", required: false }),
    f("oldestSampledAt", "Oldest Sampled Job", { required: false }),
  ],
  outputs: [o("endpoint", "API Endpoint")],
  supportsDelete: false,
  pinnable: true,
  iconKey: "workspace",
});
