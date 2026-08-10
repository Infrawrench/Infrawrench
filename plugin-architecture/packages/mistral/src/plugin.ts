import type { Plugin, PluginManifest, ResourceTypeDefinition } from "@infrawrench/plugin-base";
import { caCertCredentialField } from "@infrawrench/plugin-base";
import { MistralClient } from "./client.js";
import { MistralApiKeyResourceType } from "./resources/api-key.js";
import { MistralBatchJobResourceType } from "./resources/batch-job.js";
import { MistralFileResourceType } from "./resources/file.js";
import { MistralFineTuningJobResourceType } from "./resources/fine-tuning-job.js";
import { MistralModelResourceType } from "./resources/model.js";
import { MistralVoiceResourceType } from "./resources/voice.js";

const manifest: PluginManifest = {
  id: "mistral",
  version: "0.1.0",
  displayName: "Mistral AI",
  // Mistral's own favicon mark (mistral.ai/favicon.svg): the five-band
  // tricolour "M", rescaled from its native 183×183 box onto a dark tile.
  logoSvg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
    <rect width="100" height="100" rx="12" fill="#0A0A0A"/>
    <g transform="translate(9.6,9.8) scale(0.439)">
      <rect x="33" y="33" width="24" height="23" fill="#FFAF01"/>
      <rect x="127" y="33" width="24" height="23" fill="#FFAF01"/>
      <rect x="33" y="56" width="47" height="24" fill="#FF8204"/>
      <rect x="104" y="56" width="47" height="24" fill="#FF8204"/>
      <rect x="33" y="80" width="118" height="23" fill="#FA500F"/>
      <rect x="33" y="103" width="24" height="24" fill="#E10500"/>
      <rect x="80" y="103" width="24" height="24" fill="#E10500"/>
      <rect x="127" y="103" width="24" height="24" fill="#E10500"/>
      <rect x="10" y="127" width="70" height="23" fill="#C4001D"/>
      <rect x="104" y="127" width="70" height="23" fill="#C4001D"/>
    </g>
  </svg>`,
  author: "Infrawrench",
  minHostVersion: "0.1.0",
  credentialFields: [
    {
      key: "apiKey",
      label: "API Key",
      description:
        "A workspace API key from console.mistral.ai → API Keys. Drives models, files, fine-tuning, batch jobs, voices, transcription, and speech.",
      sensitive: true,
      placeholder: "your-mistral-api-key",
      helpLink: {
        label: "Create an API key",
        url: "https://console.mistral.ai/api-keys",
      },
    },
    {
      key: "adminApiKey",
      label: "Admin API Key (optional)",
      description:
        "An Admin API key from the Mistral backoffice. Mistral's Admin API is a separate base (api.mistral.ai/v1/admin) with its own header, and it is available on Enterprise plans only. Without it, API-key listing and usage/cost collection are unavailable — everything else works normally.",
      sensitive: true,
      optional: true,
      placeholder: "your-mistral-admin-api-key",
      helpLink: {
        label: "About the Admin API",
        url: "https://docs.mistral.ai/admin/admin-api/overview",
      },
    },
    caCertCredentialField,
  ],
  costs: {
    // `GET /v1/admin/usage` breaks spend down by service (chat, ocr, audio,
    // fine_tuning, …) but only at monthly granularity, hence `periodNative`.
    dimensions: ["service"],
    maxHistoryDays: 365,
    periodNative: true,
    /**
     * The default of 3 days is a daily provider's window and is wrong for a
     * monthly one twice over.
     *
     * Rows are dated to the **first** of their month (`client.ts` explains
     * why), and the host only asks for `[today − restatementDays, today]`, cut
     * into calendar-month chunks. A 3-day window contains the 1st on three days
     * of the month and no others — so for the rest of the month the in-progress
     * total, which Mistral restates continuously, would simply never be
     * re-collected.
     *
     * 62 days is the smallest constant that always contains the 1st of *both*
     * the in-progress month and the one before it, whatever today's date: the
     * longest two consecutive months are 62 days, so counting back 62 from any
     * day of month M reaches at or before the 1st of M−1. That buys the two
     * things a monthly provider needs — the running month re-fetched entire,
     * and a closed month re-fetched for a further month while late usage and
     * credits settle against it.
     *
     * The price is one `/admin/usage` request per month in the window, so a
     * daily collection makes three or four rather than one. That is the whole
     * cost: the endpoint is a single per-month aggregate with no pagination.
     */
    restatementDays: 62,
  },
};

const resourceTypes: ResourceTypeDefinition[] = [
  MistralModelResourceType,
  MistralVoiceResourceType,
  MistralFineTuningJobResourceType,
  MistralBatchJobResourceType,
  MistralFileResourceType,
  MistralApiKeyResourceType,
];

export const plugin: Plugin = {
  manifest,
  resourceTypes,
  createClient: (credentials, services) => new MistralClient(credentials, services),
};
