import type { Plugin, PluginManifest, ResourceTypeDefinition } from "@infrawrench/plugin-base";
import { caCertCredentialField } from "@infrawrench/plugin-base";
import { CohereClient } from "./client.js";
import { ModelResourceType } from "./resources/model.js";
import { DatasetResourceType } from "./resources/dataset.js";
import { FinetunedModelResourceType } from "./resources/finetuned-model.js";
import { EmbedJobResourceType } from "./resources/embed-job.js";
import { BatchResourceType } from "./resources/batch.js";

/**
 * Mark taken verbatim from Cohere's own `https://cohere.com/logo_mobile.svg`
 * (32×32). The three shapes and their fills — deep green `#355146`, lavender
 * `#D18EE2`, coral `#FF7759` — are the real brand asset, not a redraw; the
 * source viewBox is preserved via an inner `<svg>` so the geometry is
 * untouched, and the outer 100×100 canvas carries the usual rounded-rect
 * background. The clipPath is kept because the first path overflows the
 * viewBox without it.
 */
const LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
    <rect width="100" height="100" rx="20" fill="#FAFAF8"/>
    <svg x="18" y="18" width="64" height="64" viewBox="0 0 32 32" fill="none">
      <g clip-path="url(#cohereClip)">
        <path fill-rule="evenodd" clip-rule="evenodd" d="M10.3615 19.053C11.2016 19.053 12.8726 19.0057 15.1823 18.0307C17.8739 16.8945 23.229 14.8318 27.0919 12.7132C29.7936 11.2314 30.9779 9.27159 30.9779 6.63236C30.978 2.96943 28.0819 0 24.5094 0H9.54127C4.40983 0 0.25 4.26514 0.25 9.52649C0.25 14.7878 4.14483 19.053 10.3615 19.053Z" fill="#355146"/>
        <path fill-rule="evenodd" clip-rule="evenodd" d="M12.8928 25.6161C12.8928 23.0371 14.4071 20.7118 16.7303 19.7231L21.4441 17.7173C26.2121 15.6884 31.46 19.281 31.46 24.5741C31.46 28.6749 28.2172 31.999 24.2176 31.9979L19.114 31.9965C15.6778 31.9956 12.8928 29.1392 12.8928 25.6161Z" fill="#D18EE2"/>
        <path d="M5.60615 20.3047H5.60606C2.64799 20.3047 0.25 22.7634 0.25 25.7963V26.5076C0.25 29.5406 2.64799 31.9993 5.60606 31.9993H5.60615C8.56422 31.9993 10.9622 29.5406 10.9622 26.5076V25.7963C10.9622 22.7634 8.56422 20.3047 5.60615 20.3047Z" fill="#FF7759"/>
      </g>
      <defs>
        <clipPath id="cohereClip">
          <rect width="31.2099" height="32" fill="white" transform="translate(0.25)"/>
        </clipPath>
      </defs>
    </svg>
  </svg>`;

const manifest: PluginManifest = {
  id: "cohere",
  version: "0.1.0",
  displayName: "Cohere",
  description:
    "Cohere's Command, Embed, Rerank and Transcribe models, plus the datasets, fine-tunes, embed jobs and batches in your account.",
  logoSvg: LOGO_SVG,
  author: "Infrawrench",
  minHostVersion: "0.1.0",
  credentialFields: [
    {
      key: "apiKey",
      label: "API Key",
      description:
        "Your Cohere API key, sent as an Authorization: Bearer header. Create one at dashboard.cohere.com/api-keys. Cohere issues two kinds: a Trial key (free, heavily rate-limited, not for production) and a Production key (paid, billed per token) — either works here, and both see the same models, datasets, fine-tunes, embed jobs and batches. Cohere has no key-management API, so keys can only be created, rotated, or revoked from that dashboard page, and no usage or spend figures are readable over the API at all.",
      sensitive: true,
      placeholder: "abcDEF123456ghiJKL789012mnoPQR345678stuVW",
    },
    caCertCredentialField,
  ],
};

const resourceTypes: ResourceTypeDefinition[] = [
  ModelResourceType,
  DatasetResourceType,
  FinetunedModelResourceType,
  EmbedJobResourceType,
  BatchResourceType,
];

export const plugin: Plugin = {
  manifest,
  resourceTypes,
  createClient: (credentials, services) => new CohereClient(credentials, services),
};
