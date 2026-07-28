import type { Plugin, PluginManifest, ResourceTypeDefinition } from "@infrawrench/plugin-base";
import { caCertCredentialField } from "@infrawrench/plugin-base";
import { ReplicateClient } from "./client.js";
import { PredictionResourceType } from "./resources/prediction.js";
import { ModelResourceType } from "./resources/model.js";
import { CollectionResourceType } from "./resources/collection.js";
import { TrainingResourceType } from "./resources/training.js";
import { DeploymentResourceType } from "./resources/deployment.js";
import { HardwareResourceType } from "./resources/hardware.js";
import { FileResourceType } from "./resources/file.js";

// Mark taken verbatim from the "Replicate glyph" SVG inlined on replicate.com —
// three stepped corner polygons on a 1000×1000 canvas, drawn with
// `fill="currentColor"` in their own nav. Scaled ÷16.7 and centred on the
// 100×100 plugin canvas. The container uses Replicate's `branding-red`
// (#EA2804, the literal value behind `.text-branding-red` in their shipped
// CSS); Replicate publishes no brand-assets page, so that CSS token is the
// authoritative source for the hex.
const manifest: PluginManifest = {
  id: "replicate",
  version: "0.1.0",
  displayName: "Replicate",
  description: "Run and manage Replicate predictions, models, trainings, deployments and files.",
  logoSvg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
    <rect width="100" height="100" rx="20" fill="#EA2804"/>
    <g transform="translate(20 20) scale(0.06)" fill="#FFFFFF">
      <polygon points="1000,427.6 1000,540.6 603.4,540.6 603.4,1000 477,1000 477,427.6"/>
      <polygon points="1000,213.8 1000,327 364.8,327 364.8,1000 238.4,1000 238.4,213.8"/>
      <polygon points="1000,0 1000,113.2 126.4,113.2 126.4,1000 0,1000 0,0"/>
    </g>
  </svg>`,
  author: "Infrawrench",
  minHostVersion: "0.1.0",
  credentialFields: [
    {
      key: "apiToken",
      label: "API Token",
      description:
        "Your Replicate API token, sent as `Authorization: Bearer`. Create one at replicate.com/account/api-tokens. Replicate has a single token type — the same token covers predictions, models, trainings, deployments and files. Note that Replicate exposes no billing or usage API, so this plugin cannot show spend; use the Replicate dashboard for that.",
      sensitive: true,
      placeholder: "r8_0123456789abcdefghijklmnopqrstuvwx",
      helpLink: {
        label: "Create an API token",
        url: "https://replicate.com/account/api-tokens",
      },
    },
    caCertCredentialField,
  ],
};

const resourceTypes: ResourceTypeDefinition[] = [
  PredictionResourceType,
  DeploymentResourceType,
  ModelResourceType,
  TrainingResourceType,
  FileResourceType,
  CollectionResourceType,
  HardwareResourceType,
];

export const plugin: Plugin = {
  manifest,
  resourceTypes,
  createClient: (credentials, services) => new ReplicateClient(credentials, services),
};
