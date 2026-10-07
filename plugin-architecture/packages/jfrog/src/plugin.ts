import type { Plugin, PluginManifest } from "@infrawrench/plugin-base";
import { caCertCredentialField } from "@infrawrench/plugin-base";
import { JfrogClient } from "./client.js";
import { LOGO_SVG } from "./logo.js";
import { JFROG_PREFLIGHT } from "./preflight.js";
import { RESOURCE_TYPES } from "./resource-types.js";
import { parseStatusFeed, statusFeed } from "./status-feed.js";
import { jfrogTerraformExport } from "./terraform.js";

const manifest: PluginManifest = {
  id: "jfrog",
  version: "0.1.0",
  displayName: "JFrog",
  description:
    "JFrog Platform (cloud or self-hosted): Artifactory repositories with an artifact browser, builds, Xray watches, policies and violations, users, groups, permissions and access tokens, with storage metrics.",
  logoSvg: LOGO_SVG,
  author: "Infrawrench",
  minHostVersion: "0.1.0",
  credentialFields: [
    {
      key: "baseUrl",
      label: "Platform URL",
      description:
        "The address you open the JFrog Platform at: https://<name>.jfrog.io on JFrog Cloud, or your own host for a self-hosted platform. Paste it from the browser; a trailing /ui or /artifactory is removed.",
      sensitive: false,
      placeholder: "https://acme.jfrog.io",
    },
    {
      key: "accessToken",
      label: "Access Token",
      description:
        "An admin access token reaches everything: in the JFrog Platform open Administration, User Management, Access Tokens, Generate Token, pick Admin as the scope and copy it. A user token (Edit Profile, Generate an Identity Token) also works, limited to what that user may see; users, groups, permissions and the storage summary then need admin.",
      sensitive: true,
      placeholder: "eyJ2ZXIiOiIyIiwidHlwIjoiSldUIi…",
      helpLink: {
        label: "JFrog access tokens",
        url: "https://docs.jfrog.com/administration/docs/access-tokens",
      },
    },
    caCertCredentialField,
  ],
  preflight: JFROG_PREFLIGHT,
  statusFeed,
  // JFrog Cloud throttles per instance; stay gentle.
  rateLimit: { capacity: 10, refillPerSecond: 5 },
};

export const plugin: Plugin = {
  manifest,
  resourceTypes: RESOURCE_TYPES,
  createClient: (credentials, services) => new JfrogClient(credentials, services),
  parseStatusFeed,
  terraformExport: jfrogTerraformExport,
};
