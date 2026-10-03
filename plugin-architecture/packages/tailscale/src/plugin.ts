import type { Plugin } from "@infrawrench/plugin-base";
import { TailscaleClient } from "./client.js";
import { INSTALL_MESSAGES } from "./install.js";
import { logoSvg } from "./logo.js";
import { resourceTypes } from "./resource-types.js";

export const plugin: Plugin = {
  manifest: {
    id: "tailscale",
    version: "0.1.0",
    displayName: "Tailscale",
    description:
      "Manage your tailnet (devices, users, keys, Services, webhooks, DNS and settings) and enroll servers from any SSH-capable provider.",
    logoSvg,
    author: "Infrawrench",
    minHostVersion: "0.1.0",
    sshInstall: {
      messages: INSTALL_MESSAGES,
      description:
        "Install Tailscale on a Linux server and join this account's tailnet. Requires root or passwordless sudo and outbound HTTPS. Existing SSH and DNS settings are preserved. If your tailnet requires device approval, the server is approved with this account.",
    },
    credentialFields: [
      {
        key: "apiKey",
        label: "API access token",
        description:
          "A Tailscale API access token, not a device auth key. Used to list devices and create a short-lived, single-use enrollment key.",
        sensitive: true,
        placeholder: "tskey-api-…",
        helpLink: {
          label: "Create an API access token",
          url: "https://login.tailscale.com/admin/settings/keys",
        },
      },
      {
        key: "tailnet",
        label: "Tailnet",
        description: "Leave as - to use the tailnet belonging to your API token.",
        defaultValue: "-",
        optional: true,
        sensitive: false,
      },
    ],
  },
  resourceTypes,
  createClient: (credentials, services) => new TailscaleClient(credentials, services),
};
