import type { Plugin, PluginManifest, ResourceTypeDefinition } from "@infrawrench/plugin-base";
import { caCertCredentialField } from "@infrawrench/plugin-base";
import { FireworksClient } from "./client.js";
import { DeploymentResourceType } from "./resources/deployment.js";
import { ModelResourceType } from "./resources/model.js";
import { DatasetResourceType } from "./resources/dataset.js";
import { DeployedModelResourceType } from "./resources/deployed-model.js";
import { BatchInferenceJobResourceType } from "./resources/batch-inference-job.js";
import { SupervisedFineTuningJobResourceType } from "./resources/supervised-fine-tuning-job.js";
import { ApiKeyResourceType } from "./resources/api-key.js";
import { SecretResourceType } from "./resources/secret.js";
import { QuotaResourceType } from "./resources/quota.js";

// Mark taken verbatim from Fireworks AI's own app icon, served at
// https://fireworks.ai/icon0.svg — a chevron over two mirrored brackets, drawn
// as three paths on a 32×32 canvas in the brand violet #6720FF (the same value
// the site uses as `rgba(103, 32, 255, α)` throughout). The 32×32 artwork is
// scaled ×2 and centred on the 100×100 plugin canvas, knocked out in white on
// the violet container.
//
// NOTE: docs.fireworks.ai still serves the *old* teal→green gradient petals at
// /favicon.svg. That subdomain has not been reskinned; it is not the current
// mark and is deliberately not used here.
const manifest: PluginManifest = {
  id: "fireworks",
  version: "0.1.0",
  displayName: "Fireworks AI",
  description:
    "Manage Fireworks AI deployments, models, datasets, fine-tuning and batch jobs, API keys, secrets and quotas — with usage costs.",
  logoSvg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
    <rect width="100" height="100" rx="20" fill="#6720FF"/>
    <g transform="translate(18 18) scale(2)" fill="#FFFFFF">
      <path d="M15.9851 19.1274C15.0969 19.1274 14.2999 18.6001 13.96 17.7838L9.86258 8H12.2608L15.9991 16.9499L19.7339 8H22.1321L18.0102 17.7873C17.6686 18.6001 16.8733 19.1274 15.9851 19.1274Z"/>
      <path d="M21.3316 23.8029C20.4469 23.8029 19.6533 23.2792 19.31 22.4698C18.9649 21.6535 19.1436 20.7215 19.7672 20.0891L27.2299 12.5302L28.1618 14.7287L21.3298 21.636L31.068 21.5817L32 23.7802L21.3333 23.8065L21.3298 23.8029H21.3316Z"/>
      <path d="M0 23.7766L0.931955 21.5781L10.6702 21.6324L3.83993 14.7234L4.77189 12.5249L12.2345 20.0838C12.8582 20.7145 13.0386 21.65 12.6918 22.4645C12.3484 23.2756 11.5513 23.7977 10.6702 23.7977L0.00350359 23.7731L0 23.7766Z"/>
    </g>
  </svg>`,
  author: "Infrawrench",
  minHostVersion: "0.1.0",
  credentialFields: [
    {
      key: "apiKey",
      label: "API Key",
      description:
        "Your Fireworks API key, sent as `Authorization: Bearer`. Create one at app.fireworks.ai under Account Settings → API Keys. The same key works for both planes — inference at api.fireworks.ai/inference/v1 and the control plane at api.fireworks.ai/v1/accounts/…",
      sensitive: true,
      placeholder: "fw_0123456789abcdefghijklmn",
      helpLink: {
        label: "Create an API key",
        url: "https://app.fireworks.ai/settings/users/api-keys",
      },
    },
    {
      key: "accountId",
      label: "Account ID",
      description:
        "Your Fireworks account id — required, because Fireworks has no whoami endpoint for the plugin to discover it. It is the `accounts/<id>/` prefix on any of your model strings (e.g. `accounts/my-team/models/my-model` → `my-team`), and it is shown at the top of app.fireworks.ai. Without it every control-plane call 404s and nothing lists.",
      sensitive: false,
      placeholder: "my-team",
      helpLink: { label: "Find your account id", url: "https://app.fireworks.ai/" },
    },
    caCertCredentialField,
  ],
  costs: {
    // `usageCosts:query` groups by DAY + MODEL, so a cost row's "service" is
    // the model that produced the spend. No region or tag dimension exists.
    dimensions: ["service"],
    maxHistoryDays: 365,
    restatementDays: 3,
  },
};

const resourceTypes: ResourceTypeDefinition[] = [
  DeploymentResourceType,
  ModelResourceType,
  DeployedModelResourceType,
  DatasetResourceType,
  SupervisedFineTuningJobResourceType,
  BatchInferenceJobResourceType,
  ApiKeyResourceType,
  SecretResourceType,
  QuotaResourceType,
];

export const plugin: Plugin = {
  manifest,
  resourceTypes,
  createClient: (credentials, services) => new FireworksClient(credentials, services),
};
