import { f, o, rt } from "@infrawrench/plugin-base";

/**
 * The API key itself, as a single always-present resource.
 *
 * AssemblyAI has no account, usage, billing or quota endpoint, so there is
 * nothing to fetch that describes the key directly. What this resource carries
 * is therefore derived from the transcript list plus the credential's own
 * region — and, more importantly, it is the one resource that exists on a
 * freshly added account. Transcripts only appear once the key has been used,
 * so hanging the Speech tab off them alone would gate the plugin's only feature
 * behind already having used it.
 */
export const AccountResourceType = rt({
  name: "Account",
  plural: "Account",
  id: "account",
  description:
    "The AssemblyAI API key, its recent transcription activity, and the Speech playground",
  fields: [
    f("endpoint", "API Endpoint", { required: false }),
    f("region", "API Region", { required: false }),
    f("sampledTranscripts", "Transcripts Sampled", { kind: "number", required: false }),
    f("completedTranscripts", "Completed", { kind: "number", required: false }),
    f("erroredTranscripts", "Failed", { kind: "number", required: false }),
    f("pendingTranscripts", "Queued or Processing", { kind: "number", required: false }),
    f("oldestSampledAt", "Oldest Sampled Transcript", { required: false }),
  ],
  outputs: [
    o("endpoint", "API Endpoint", {
      description: "Host this account's transcripts live on. Regions do not share data.",
    }),
    o("region", "API Region"),
  ],
  supportsDelete: false,
  iconKey: "account",
});
