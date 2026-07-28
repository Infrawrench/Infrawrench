import type { Plugin, PluginManifest, ResourceTypeDefinition } from "@infrawrench/plugin-base";
import { caCertCredentialField } from "@infrawrench/plugin-base";
import { TogetherClient } from "./client.js";
import { ModelResourceType } from "./resources/model.js";
import { FineTuneResourceType } from "./resources/fine-tune.js";
import { FileResourceType } from "./resources/file.js";
import { EndpointResourceType } from "./resources/endpoint.js";
import { ManagedEndpointResourceType } from "./resources/managed-endpoint.js";
import { HardwareResourceType } from "./resources/hardware.js";
import { BatchResourceType } from "./resources/batch.js";
import { EvaluationResourceType } from "./resources/evaluation.js";

// Mark taken verbatim from Together AI's own favicon, served at
// https://api.together.ai/favicon.svg — three overlapping lobes in the brand
// magenta (#EF2CC1), lilac (#CAAEF5) and orange (#FC4C02). The source artwork
// is 484.98×452.5; it is scaled ÷7.14 and centred on the 100×100 plugin canvas
// over a near-black container so the three colours stay legible on both themes.
const manifest: PluginManifest = {
  id: "together",
  version: "0.1.0",
  displayName: "Together AI",
  description:
    "Serverless and dedicated inference, fine-tuning, batch jobs and evaluations on Together AI.",
  logoSvg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
    <rect width="100" height="100" rx="20" fill="#0D0D0D"/>
    <g transform="translate(16 18.3) scale(0.14)">
      <path fill="#EF2CC1" d="M468.72,60.67C435.25,2.69,361.11-17.18,303.12,16.3c-37.3,21.54-58.82,59.62-60.52,99.69l121.15.16v10.39h-121.15c.78,18.94,6.02,37.81,16.15,55.36,33.48,57.98,107.62,77.85,165.6,44.37,57.98-33.48,77.85-107.62,44.37-165.6Z"/>
      <path fill="#CAAEF5" d="M16.26,60.63C-17.21,118.61,2.65,192.76,60.63,226.23c37.3,21.54,81.04,21.13,116.59,2.57l-60.44-105,9-5.18,60.57,104.91c16.01-10.14,29.74-24.12,39.87-41.67,33.48-57.98,13.61-132.12-44.37-165.6C123.88-17.21,49.74,2.65,16.26,60.63Z"/>
      <path fill="#FC4C02" d="M242.46,452.5c66.95,0,121.23-54.27,121.23-121.23,0-43.07-22.22-80.75-56.07-102.25l-60.71,104.84-8.99-5.21,60.57-104.91c-16.79-8.79-35.75-13.7-56.02-13.7-66.95,0-121.23,54.27-121.23,121.23,0,66.95,54.27,121.23,121.23,121.23Z"/>
    </g>
  </svg>`,
  author: "Infrawrench",
  minHostVersion: "0.1.0",
  credentialFields: [
    {
      key: "apiKey",
      label: "API Key",
      description:
        "Your Together AI API key, sent as `Authorization: Bearer`. Create one at api.together.ai/settings/api-keys. Together has a single key type — the same key covers inference, fine-tuning, files, dedicated endpoints, batches and evaluations, so there is no second admin key to add. The project this key belongs to is discovered automatically from GET /v1/whoami; you do not need to paste a project id.",
      sensitive: true,
      placeholder: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      helpLink: { label: "Create an API key", url: "https://api.together.ai/settings/api-keys" },
    },
    caCertCredentialField,
  ],
};

const resourceTypes: ResourceTypeDefinition[] = [
  EndpointResourceType,
  ManagedEndpointResourceType,
  ModelResourceType,
  FineTuneResourceType,
  FileResourceType,
  BatchResourceType,
  EvaluationResourceType,
  HardwareResourceType,
];

export const plugin: Plugin = {
  manifest,
  resourceTypes,
  createClient: (credentials, services) => new TogetherClient(credentials, services),
};
