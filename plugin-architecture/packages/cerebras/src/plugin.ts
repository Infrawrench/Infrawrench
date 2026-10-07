import type { Plugin, PluginManifest } from "@infrawrench/plugin-base";
import { caCertCredentialField } from "@infrawrench/plugin-base";
import { CerebrasClient } from "./client.js";
import { RESOURCE_TYPES } from "./resource-types.js";
import { parseStatusFeed, statusFeed } from "./status-feed.js";

// Cerebras mark (orange concentric arcs around the "C"), from the lobe-icons
// set (@lobehub/icons-static-svg, cerebras-color.svg), 24x24 scaled x3 and
// centred on a white rounded square. The black "C" had no fill in the
// source (currentColor), so it is pinned to near-black here.
const LOGO = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <rect width="100" height="100" rx="20" fill="#FFFFFF"/>
  <g transform="translate(14 14) scale(3)">
    <path clip-rule="evenodd" d="M14.121 2.701a9.299 9.299 0 000 18.598V22.7c-5.91 0-10.7-4.791-10.7-10.701S8.21 1.299 14.12 1.299V2.7zm4.752 3.677A7.353 7.353 0 109.42 17.643l-.901 1.074a8.754 8.754 0 01-1.08-12.334 8.755 8.755 0 0112.335-1.08l-.901 1.075zm-2.255.844a5.407 5.407 0 00-5.048 9.563l-.656 1.24a6.81 6.81 0 016.358-12.043l-.654 1.24zM14.12 8.539a3.46 3.46 0 100 6.922v1.402a4.863 4.863 0 010-9.726v1.402z" fill="#F15A29" fill-rule="evenodd"/>
    <path d="M15.407 10.836a2.24 2.24 0 00-.51-.409 1.084 1.084 0 00-.544-.152c-.255 0-.483.047-.684.14a1.58 1.58 0 00-.84.912c-.074.203-.11.416-.11.631 0 .218.036.43.11.631a1.594 1.594 0 00.84.913c.2.093.43.14.684.14.216 0 .417-.046.602-.135.188-.09.35-.225.475-.392l.928 1.006c-.14.14-.3.261-.482.363a3.367 3.367 0 01-1.083.38c-.17.026-.317.04-.44.04a3.315 3.315 0 01-1.182-.21 2.825 2.825 0 01-.961-.597 2.816 2.816 0 01-.644-.929 2.987 2.987 0 01-.238-1.21c0-.444.08-.847.238-1.21.15-.35.368-.666.643-.929.278-.261.605-.464.962-.596a3.315 3.315 0 011.182-.21c.355 0 .712.068 1.072.204.361.138.685.36.944.649l-.962.97z" fill="#231F20"/>
  </g>
</svg>`;

const manifest: PluginManifest = {
  id: "cerebras",
  version: "0.1.0",
  displayName: "Cerebras",
  description:
    "Cerebras Inference models with prices and a Playground, batches and files, and Dedicated Inference endpoints and model versions.",
  logoSvg: LOGO,
  author: "Infrawrench",
  minHostVersion: "0.1.0",
  credentialFields: [
    {
      key: "apiKey",
      label: "API Key",
      description:
        "An inference API key from cloud.cerebras.ai → API Keys (on paid plans, pick the project first: the key inherits its rate limits). Keys have no scopes; one key lists models and runs chat, batches and files.",
      sensitive: true,
      placeholder: "csk-...",
      helpLink: { label: "Create an API key", url: "https://cloud.cerebras.ai" },
    },
    {
      key: "organizationId",
      label: "Organization ID (Dedicated Inference)",
      description:
        "Optional. Your organization ID from the Cloud console Settings page, used to read Dedicated Inference endpoint metrics.",
      sensitive: false,
      optional: true,
      placeholder: "org_abc123",
    },
    {
      key: "orgName",
      label: "Organization Name (Dedicated Inference)",
      description:
        "Optional. The organization name that prefixes your dedicated endpoint ids (my-org in my-org-gpt-oss-120b). Needed with the management key below.",
      sensitive: false,
      optional: true,
      placeholder: "my-org",
    },
    {
      key: "managementKey",
      label: "Management API Key (Dedicated Inference)",
      description:
        "Optional, Private Preview. The separate key under Management API keys on the Cloud console's API Keys page. Lists dedicated endpoints and model versions, uploads weights and deploys versions.",
      sensitive: true,
      optional: true,
      placeholder: "management key",
    },
    caCertCredentialField,
  ],
  statusFeed,
};

export const plugin: Plugin = {
  manifest,
  resourceTypes: RESOURCE_TYPES,
  createClient: (credentials, services) => new CerebrasClient(credentials, services),
  parseStatusFeed,
};
