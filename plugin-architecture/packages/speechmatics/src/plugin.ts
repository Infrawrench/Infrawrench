import type { Plugin, PluginManifest, ResourceTypeDefinition } from "@infrawrench/plugin-base";
import { caCertCredentialField } from "@infrawrench/plugin-base";
import { SpeechmaticsClient } from "./client.js";
import { AccountResourceType } from "./resources/account.js";
import { JobResourceType } from "./resources/job.js";
import { ProjectResourceType } from "./resources/project.js";
import { ApiKeyResourceType } from "./resources/api-key.js";

/**
 * Speechmatics mark taken from the official docs asset
 * (https://docs.speechmatics.com/img/logo.svg — `viewBox="0 0 24 24"`), with
 * the brand hex #0d3c48 lifted from the wordmark
 * (https://www.speechmatics.com/_next/static/media/SM-Logo-main.b945b6cd.svg).
 * Re-centred into a 100×100 rounded square: the glyph's bounding box is
 * centred on (12,12) in the source, so scale(3.4) + translate(9.2,9.2) puts it
 * back in the middle at ~55% of the tile.
 */
const logoSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <rect width="100" height="100" rx="12" fill="#0d3c48"/>
  <g transform="translate(9.2,9.2) scale(3.4)" fill="#ffffff">
    <path d="M17.4302 6.65978C16.6044 5.91456 15.6819 5.35866 14.7031 4.98L15.6255 2.58319C12.3224 1.31429 8.43911 2.12799 5.9295 4.90749C4.88619 6.0636 4.20944 7.42112 3.88718 8.83504C3.19835 11.8442 4.12082 15.1272 6.57403 17.3387C7.39982 18.0839 8.33035 18.6439 9.31324 19.0225L8.39077 21.4234C11.6899 22.6842 15.5651 21.8745 18.0707 19.091C19.114 17.9349 19.7907 16.5814 20.113 15.1634C20.8018 12.1543 19.8794 8.8713 17.4262 6.65978H17.4302ZM15.5732 16.8271C14.0263 18.5431 11.6375 19.0427 9.59925 18.2733C8.98695 18.0396 8.40688 17.6932 7.89127 17.2259C5.65961 15.2158 5.48237 11.7757 7.49247 9.54402C9.04738 7.81992 11.4563 7.32042 13.4986 8.11399C14.0988 8.34762 14.6668 8.69003 15.1744 9.14522C17.406 11.1553 17.5833 14.5955 15.5732 16.8271Z"/>
  </g>
</svg>`;

const manifest: PluginManifest = {
  id: "speechmatics",
  version: "0.1.0",
  displayName: "Speechmatics",
  logoSvg,
  author: "Infrawrench",
  minHostVersion: "0.1.0",
  credentialFields: [
    {
      key: "apiKey",
      label: "API Key",
      description:
        "Batch API key from the Speechmatics Portal — Manage workspace › API keys. Sent as `Authorization: Bearer …`. This is the key that lists and submits transcription jobs; it cannot read the Management API.",
      sensitive: true,
      placeholder: "your-speechmatics-api-key",
      helpLink: {
        label: "Create an API key in the Speechmatics Portal",
        url: "https://portal.speechmatics.com/",
      },
    },
    {
      key: "region",
      label: "Region",
      description:
        "Regional batch endpoint your jobs live on. Jobs are region-scoped — a job submitted to eu1 is invisible from us1 or au1, and every request for a job must go to the same region. Pick the region your API key was created in. Note that au1 is batch-only.",
      sensitive: false,
      defaultValue: "eu1",
      regions: [
        { id: "eu1", label: "EU (eu1)", location: "Europe", flag: "🇪🇺" },
        { id: "us1", label: "US (us1)", location: "United States", flag: "🇺🇸" },
        { id: "au1", label: "Australia (au1)", location: "Australia", flag: "🇦🇺" },
      ],
    },
    {
      key: "managementToken",
      label: "Management Token (optional)",
      description:
        "Optional. A management token from the Portal — Manage workspace › Management tokens. This is a *different* credential to the API key above, and it talks to a different host: the Management API is served from https://mp.api.speechmatics.com/v1, not the regional ASR endpoint. Without it the Projects and API Keys resource types stay empty; transcription jobs and the Speech tab are unaffected.",
      sensitive: true,
      optional: true,
      placeholder: "your-speechmatics-management-token",
      helpLink: {
        label: "Create a management token",
        url: "https://docs.speechmatics.com/administration/management-tokens",
      },
    },
    caCertCredentialField,
  ],
  /**
   * Estimated spend, priced from `GET /v2/usage` (see `cost-data.ts`).
   *
   * `dimensions: ["service"]` — the usage endpoint breaks consumption down by
   * `mode` and `operating_point`, which together are exactly the line items on
   * the pricing page ("Batch Enhanced", "Real-time Standard", …), so that pair
   * is the service. Region is not a dimension: an account is bound to one
   * regional endpoint by its credential, so it would be a constant column.
   * There is no per-resource dimension either — usage is account-wide and is
   * not attributed back to individual jobs, and jobs are purged after 7 days
   * anyway, so per-resource rows would outlive the resources they name.
   *
   * `estimated: true` — Speechmatics has no billing API. These amounts are
   * metered hours × published list rates, so they miss the automatic >500
   * hr/month volume discount, the opt-in model-training discount, and sign-up
   * credit. See the rate-card comment in `cost-data.ts`.
   *
   * `restatementDays: 2` — usage for the current UTC day is excluded from the
   * endpoint's results, so every collection has at least one open day it
   * cannot see yet. Two days of trailing re-fetch closes that gap with a day
   * to spare, at a cost of two requests per pass.
   *
   * `maxHistoryDays: 90` — deliberately far below the 365 default, because
   * history here is priced in requests, not in bytes. The endpoint aggregates
   * over its whole `since..until` window with no daily buckets, so one day of
   * cost data is one HTTP request: a 365-day backfill would be 365 sequential
   * requests against a `429` ceiling the API documents but never quantifies,
   * on a key that is simultaneously being used to submit real transcription
   * work. 90 days is three closed billing cycles — enough for a
   * month-over-month trend and a quarter-shaped chart — and keeps the first
   * collection to ~90 requests, roughly half a minute of paced traffic.
   */
  costs: {
    dimensions: ["service"],
    maxHistoryDays: 90,
    restatementDays: 2,
    estimated: true,
  },
};

// Account first: it is the only type guaranteed to exist. Jobs expire after 7
// days, and projects and API keys need the optional management token — so the
// Speech tab hangs off the account, not off a job that may have been purged.
const resourceTypes: ResourceTypeDefinition[] = [
  AccountResourceType,
  JobResourceType,
  ProjectResourceType,
  ApiKeyResourceType,
];

export const plugin: Plugin = {
  manifest,
  resourceTypes,
  createClient: (credentials, services) => new SpeechmaticsClient(credentials, services),
};
