import type { PluginManifest } from "@infrawrench/plugin-base";
import { defineCredentials, definePlugin } from "@infrawrench/plugin-base";
import type { CredentialsOf } from "@infrawrench/plugin-base";
import { TailscaleClient } from "./client.js";
import { INSTALL_MESSAGES } from "./install.js";
import { logoSvg } from "./logo.js";
import { tailscaleSeatRemediationCommands } from "./remediation.js";
import { resourceTypes } from "./resource-types.js";

export const manifest = {
  id: "tailscale",
  egressHosts: ["api.tailscale.com"],
  displayName: "Tailscale",
  description:
    "Manage your tailnet (devices, users, keys, Services, webhooks, DNS and settings) and enroll servers from any SSH-capable provider.",
  logoSvg,
  sshInstall: {
    messages: INSTALL_MESSAGES,
    description:
      "Install Tailscale on a Linux server and join this account's tailnet. Requires root or passwordless sudo and outbound HTTPS. Existing SSH and DNS settings are kept, and the server is approved automatically if the tailnet requires approval.",
  },
  credentialFields: defineCredentials([
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
    {
      key: "seatPriceMonthly",
      label: "Seat price (USD per seat per month)",
      description:
        "What one Tailscale seat costs you per month. The API does not report your plan, so without this the Seats page estimates with the Standard plan's list price of $8 (Premium is $18). Enter 0 for the free Personal plan.",
      sensitive: false,
      optional: true,
      advanced: true,
      placeholder: "8",
    },
  ]),
  seats: { products: ["Tailscale"], removal: true },
} satisfies PluginManifest;

export type Credentials = CredentialsOf<typeof manifest>;

export const plugin = definePlugin({
  manifest,
  resourceTypes,
  createClient: (credentials, services) => new TailscaleClient(credentials, services),
  testCredentials: { apiKey: "tskey-api-test", tailnet: "-" },
  seatRemediationCommands: tailscaleSeatRemediationCommands,
});
