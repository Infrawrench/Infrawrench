import type { Plugin, PluginManifest, ResourceTypeDefinition } from "@infrawrench/plugin-base";
import { caCertCredentialField } from "@infrawrench/plugin-base";
import { GladiaClient } from "./client.js";
import { TranscriptionResourceType } from "./resources/transcription.js";
import { WorkspaceResourceType } from "./resources/workspace.js";

// Mark taken verbatim from Gladia's own https://www.gladia.io/favicon.svg
// (identical geometry to the logo they ship at /logos/comparison/gladia.svg).
// The original is a 1080×1080 canvas with rx 180 and the glyph pre-transformed
// by translate(140,140) scale(0.74); that whole canvas is scaled ÷10.8 onto the
// 100×100 plugin card, keeping the brand black #0C0C0C.
const manifest: PluginManifest = {
  id: "gladia",
  version: "0.1.0",
  displayName: "Gladia",
  logoSvg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
    <rect width="100" height="100" rx="16.7" fill="#0C0C0C"/>
    <g transform="scale(0.0925926)">
      <path fill="#fff" transform="translate(140,140) scale(0.74)" d="M557.83,699.88c68.85,0,134.89,27.36,183.59,76.07l188.67,219.28h-109.92c-28.48,0-55.6-12.27-74.42-33.69l-156.27-177.97v296.43h-104.71v-290.03l-150.63,171.53c-18.78,21.38-45.9,33.67-74.42,33.67h-110l188.8-219.28c48.71-48.7,114.75-76.07,183.59-76.07h35.71v.05ZM304.08,338.61c48.7,48.7,76.07,114.74,76.07,183.58v35.7c0,68.84-27.36,134.88-76.07,183.58l-219.31,188.66v-109.91l-.04-.04c0-28.48,12.3-55.6,33.72-74.42l177.99-156.26H0v-104.71h290.05l-171.55-150.61c-21.42-18.78-33.72-45.89-33.72-74.41v-110l219.31,188.83ZM995.18,259.68c0,28.48-12.26,55.6-33.69,74.42l-177.99,156.26h296.5v104.71h-290.05l171.54,150.6c21.38,18.78,33.69,45.9,33.69,74.42v110l-219.3-188.79c-48.71-48.7-76.08-114.74-76.08-183.58v-35.7c0-68.84,27.37-134.88,76.08-183.58l219.3-188.66v109.91ZM595.1,289.94l150.62-171.53c18.78-21.38,45.9-33.67,74.42-33.67h110l-188.79,219.29c-48.71,48.7-114.76,76.06-183.61,76.06h-35.7l-.04.04c-68.85,0-134.89-27.36-183.59-76.07L149.73,84.77h109.92c28.48,0,55.6,12.3,74.42,33.72l156.31,177.92V0h104.72v289.94Z"/>
    </g>
  </svg>`,
  author: "Infrawrench",
  minHostVersion: "0.1.0",
  credentialFields: [
    {
      key: "apiKey",
      label: "API Key",
      description:
        "Your Gladia API key, sent as the x-gladia-key header (Gladia does not use Bearer auth). Find it in the Gladia dashboard at app.gladia.io under Account → API Keys. A single key covers uploads, pre-recorded transcription and the job history — there is no separate admin or usage key.",
      sensitive: true,
      placeholder: "0123abcd-4567-89ef-0123-456789abcdef",
      helpLink: { label: "Open the Gladia dashboard", url: "https://app.gladia.io/" },
    },
    caCertCredentialField,
  ],
};

const resourceTypes: ResourceTypeDefinition[] = [WorkspaceResourceType, TranscriptionResourceType];

export const plugin: Plugin = {
  manifest,
  resourceTypes,
  createClient: (credentials, services) => new GladiaClient(credentials, services),
};
