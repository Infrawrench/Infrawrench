import type { Plugin, PluginManifest } from "@infrawrench/plugin-base";
import { caCertCredentialField } from "@infrawrench/plugin-base";
import { PaperspaceClient } from "./client.js";
import { LOGO_SVG } from "./logo.js";
import { RESOURCE_TYPES } from "./resource-types.js";
import { parseStatusFeed, statusFeed } from "./status-feed.js";

const manifest: PluginManifest = {
  id: "paperspace",
  version: "0.1.0",
  displayName: "Paperspace",
  description:
    "GPU machines from DigitalOcean's Paperspace. Machines with start, stop and resize, snapshots, custom templates, shared drives, private networks, static IPs, startup scripts, projects, container deployments with metrics, and registry credentials.",
  logoSvg: LOGO_SVG,
  author: "Infrawrench",
  minHostVersion: "0.1.0",
  credentialFields: [
    {
      key: "apiKey",
      label: "API Key",
      description:
        "A Paperspace API key: in the Paperspace console click your profile icon, Team Settings, API Keys, enter a name and click Add. Keys act for you within that team and see everything the team owns.",
      sensitive: true,
      placeholder: "",
      helpLink: {
        label: "Paperspace API keys",
        url: "https://docs.digitalocean.com/reference/paperspace/api-keys/",
      },
    },
    caCertCredentialField,
  ],
  statusFeed,
};

export const plugin: Plugin = {
  manifest,
  resourceTypes: RESOURCE_TYPES,
  createClient: (credentials, services) =>
    new PaperspaceClient(credentials, RESOURCE_TYPES, services),
  parseStatusFeed,
};
