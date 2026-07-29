import { f, o, rt } from "@infrawrench/plugin-base";

/**
 * The Speechmatics account itself, as a single always-present resource.
 *
 * Nothing else here is guaranteed to exist. Jobs are purged 7 days after they
 * run (https://docs.speechmatics.com/speech-to-text/batch/limits), and projects
 * and API keys only appear when the optional management token is set — so on a
 * new or week-idle account the sidebar would otherwise be empty and the Speech
 * tab unreachable. `listResources` always returns exactly one of these.
 *
 * Its content comes from `GET /v2/usage` (the 30-day summary) and
 * `GET /v1/discovery/features` (the live language packs), both on the account's
 * own region.
 */
export const AccountResourceType = rt({
  name: "Account",
  plural: "Account",
  id: "account",
  description:
    "The Speechmatics account on this region — its 30-day usage summary, the language packs the batch engine currently offers, and the Speech playground.",
  fields: [
    f("region", "Region"),
    f("endpoint", "Batch API Endpoint", { required: false }),
    f("managementToken", "Management Token Set", { kind: "boolean", required: false }),
    f("usageSince", "Usage Window Start", { required: false }),
    f("usageUntil", "Usage Window End", { required: false }),
    f("usageHours", "Transcription Hours (30d)", { kind: "number", required: false }),
    f("usageJobs", "Billable Jobs (30d)", { kind: "number", required: false }),
    f("languagePacks", "Language Packs Offered", { kind: "number", required: false }),
  ],
  outputs: [
    o("region", "Region", { description: "Regional endpoint this account's jobs live on." }),
    o("endpoint", "Batch API Endpoint", {
      description: "Regional ASR base URL (https://{region}.asr.api.speechmatics.com/v2).",
    }),
  ],
  supportsDelete: false,
  iconKey: "account",
});
