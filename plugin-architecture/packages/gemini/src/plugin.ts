import type { Plugin, PluginManifest, ResourceTypeDefinition } from "@infrawrench/plugin-base";
import { caCertCredentialField } from "@infrawrench/plugin-base";
import { GeminiClient } from "./client.js";
import { ModelResourceType } from "./resources/model.js";
import { TunedModelResourceType } from "./resources/tuned-model.js";
import { FileResourceType } from "./resources/file.js";
import { CachedContentResourceType } from "./resources/cached-content.js";
import { BatchResourceType } from "./resources/batch.js";
import { FileSearchStoreResourceType } from "./resources/file-search-store.js";
import { FileSearchDocumentResourceType } from "./resources/file-search-document.js";

/**
 * The Gemini "sparkle" mark, taken verbatim from Google's own CDN asset at
 * `https://www.gstatic.com/lamda/images/gemini_sparkle_v002_d4735304ff6292a690345.svg`
 * (28×28). The path data and the radial-gradient stops — `#9168C0` purple,
 * `#5684D1` indigo, `#1BA1E3` cyan-blue — are the real brand asset, not a
 * redraw. The source viewBox is preserved via an inner `<svg>` so the geometry
 * and gradient transform stay intact on the 100×100 plugin canvas.
 */
const LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
    <rect width="100" height="100" rx="20" fill="#FFFFFF"/>
    <svg x="18" y="18" width="64" height="64" viewBox="0 0 28 28" fill="none">
      <path d="M14 28C14 26.0633 13.6267 24.2433 12.88 22.54C12.1567 20.8367 11.165 19.355 9.905 18.095C8.645 16.835 7.16333 15.8433 5.46 15.12C3.75667 14.3733 1.93667 14 0 14C1.93667 14 3.75667 13.6383 5.46 12.915C7.16333 12.1683 8.645 11.165 9.905 9.905C11.165 8.645 12.1567 7.16333 12.88 5.46C13.6267 3.75667 14 1.93667 14 0C14 1.93667 14.3617 3.75667 15.085 5.46C15.8317 7.16333 16.835 8.645 18.095 9.905C19.355 11.165 20.8367 12.1683 22.54 12.915C24.2433 13.6383 26.0633 14 28 14C26.0633 14 24.2433 14.3733 22.54 15.12C20.8367 15.8433 19.355 16.835 18.095 18.095C16.835 19.355 15.8317 20.8367 15.085 22.54C14.3617 24.2433 14 26.0633 14 28Z" fill="url(#geminiSparkle)"/>
      <defs>
        <radialGradient id="geminiSparkle" cx="0" cy="0" r="1" gradientUnits="userSpaceOnUse" gradientTransform="translate(2.77876 11.3795) rotate(18.6832) scale(29.8025 238.737)">
          <stop offset="0.0671246" stop-color="#9168C0"/>
          <stop offset="0.342551" stop-color="#5684D1"/>
          <stop offset="0.672076" stop-color="#1BA1E3"/>
        </radialGradient>
      </defs>
    </svg>
  </svg>`;

const manifest: PluginManifest = {
  id: "gemini",
  version: "0.1.0",
  displayName: "Google Gemini",
  description:
    "The Gemini API on Google AI Studio — models, tuned models, uploaded files, context caches, batch jobs and File Search stores, plus speech synthesis and transcription.",
  logoSvg: LOGO_SVG,
  author: "Infrawrench",
  minHostVersion: "0.1.0",
  credentialFields: [
    {
      key: "apiKey",
      label: "API Key",
      description:
        "Your Google AI Studio API key, sent as the x-goog-api-key header. Create one at aistudio.google.com/app/apikey — keys start with 'AIza'. This is the AI Studio key, not a Vertex AI service account and not a Google Cloud OAuth credential; Infrawrench has a separate Google Cloud plugin for those. Note that generativelanguage.googleapis.com has no admin, usage, quota or billing endpoints of any kind, so this plugin can list and manage your models, files, caches, batches and File Search stores but cannot report spend or remaining quota — those stay in AI Studio.",
      sensitive: true,
      placeholder: "AIzaSy...",
    },
    caCertCredentialField,
  ],
};

const resourceTypes: ResourceTypeDefinition[] = [
  ModelResourceType,
  TunedModelResourceType,
  FileResourceType,
  CachedContentResourceType,
  BatchResourceType,
  FileSearchStoreResourceType,
  FileSearchDocumentResourceType,
];

export const plugin: Plugin = {
  manifest,
  resourceTypes,
  createClient: (credentials, services) => new GeminiClient(credentials, services),
};
