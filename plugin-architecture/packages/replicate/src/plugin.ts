import { defineCredentials, definePlugin } from "@infrawrench/plugin-base";
import type {
  PluginManifest,
  ResourceTypeDefinition,
  CredentialsOf,
} from "@infrawrench/plugin-base";
import { caCertCredentialField } from "@infrawrench/plugin-base";
import { ReplicateClient } from "./client.js";
import { parseStatusFeed, statusFeed } from "./status-feed.js";
import { PredictionResourceType } from "./resources/prediction.js";
import { ModelResourceType } from "./resources/model.js";
import { ModelVersionResourceType } from "./resources/model-version.js";
import { CollectionResourceType } from "./resources/collection.js";
import { TrainingResourceType } from "./resources/training.js";
import { DeploymentResourceType } from "./resources/deployment.js";
import { HardwareResourceType } from "./resources/hardware.js";
import { FileResourceType } from "./resources/file.js";

// Mark taken verbatim from the "Replicate glyph" SVG inlined on replicate.com:
// three stepped corner polygons on a 1000×1000 canvas, drawn with
// `fill="currentColor"` in their own nav. Scaled ÷16.7 and centred on the
// 100×100 plugin canvas. The container uses Replicate's `branding-red`
// (#EA2804, the literal value behind `.text-branding-red` in their shipped
// CSS); Replicate publishes no brand-assets page, so that CSS token is the
// authoritative source for the hex.
export const manifest = {
  id: "replicate",
  egressHosts: ["api.replicate.com", "replicate.delivery"],
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
  credentialFields: defineCredentials([
    {
      key: "apiToken",
      label: "API Token",
      description:
        "Your Replicate API token, sent as `Authorization: Bearer`. Create one at replicate.com/account/api-tokens. One token covers predictions, models, trainings, deployments and files. Replicate has no billing or usage API, so spend is only in its dashboard.",
      sensitive: true,
      placeholder: "r8_0123456789abcdefghijklmnopqrstuvwx",
      helpLink: {
        label: "Create an API token",
        url: "https://replicate.com/account/api-tokens",
      },
    },
    caCertCredentialField,
  ]),
  statusFeed,
} satisfies PluginManifest;

export type Credentials = CredentialsOf<typeof manifest>;

const resourceTypes: ResourceTypeDefinition[] = [
  PredictionResourceType,
  DeploymentResourceType,
  ModelResourceType,
  ModelVersionResourceType,
  TrainingResourceType,
  FileResourceType,
  CollectionResourceType,
  HardwareResourceType,
];

export const plugin = definePlugin({
  manifest,
  resourceTypes,
  createClient: (credentials, services) => new ReplicateClient(credentials, services),
  testCredentials: { apiToken: "r8_test_replicate_token" },
  parseStatusFeed,
});
