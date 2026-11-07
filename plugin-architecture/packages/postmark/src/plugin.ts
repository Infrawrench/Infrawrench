import { defineCredentials, definePlugin } from "@infrawrench/plugin-base";
import type { PluginManifest, CredentialsOf } from "@infrawrench/plugin-base";
import { caCertCredentialField } from "@infrawrench/plugin-base";
import { PostmarkClient } from "./client.js";
import { LOGO_SVG } from "./logo.js";
import { RESOURCE_TYPES } from "./resource-types.js";
import { parseStatusFeed, statusFeed } from "./status-feed.js";

export const manifest = {
  id: "postmark",
  egressHosts: ["api.postmarkapp.com"],
  displayName: "Postmark",
  description:
    "Transactional and broadcast email. Manage servers, message streams, sending domains with their DKIM and Return-Path DNS records, sender signatures, webhooks, templates, suppressions and inbound rules, and chart daily sends, bounces, spam complaints, opens and clicks.",
  logoSvg: LOGO_SVG,
  credentialFields: defineCredentials([
    {
      key: "accountToken",
      label: "Account API Token",
      description:
        "Recommended. In Postmark, open Account, then API Tokens, and copy the account token (only the account owner and admins can see it). It manages every server, domain and sender signature, and Postmark hands back each server's own token for streams, webhooks, templates and stats.",
      sensitive: true,
      optional: true,
      placeholder: "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
      helpLink: {
        label: "Open Postmark API tokens",
        url: "https://account.postmarkapp.com/api_tokens",
      },
    },
    {
      key: "serverToken",
      label: "Server API Token",
      description:
        "Only needed without an account token: a single server's token, from the server's API Tokens tab. It manages just that server (its streams, webhooks, templates, suppressions and stats); domains and sender signatures need the account token.",
      sensitive: true,
      optional: true,
      placeholder: "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
    },
    caCertCredentialField,
  ]),
  statusFeed,
} satisfies PluginManifest;

export type Credentials = CredentialsOf<typeof manifest>;

export const plugin = definePlugin({
  manifest,
  resourceTypes: RESOURCE_TYPES,
  createClient: (credentials, services) => new PostmarkClient(credentials, services),
  testCredentials: { accountToken: "test-postmark-account-token" },
  parseStatusFeed,
});
