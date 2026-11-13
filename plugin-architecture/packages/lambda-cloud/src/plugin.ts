import { defineCredentials, definePlugin } from "@infrawrench/plugin-base";
import type { PluginManifest, CredentialsOf } from "@infrawrench/plugin-base";
import { caCertCredentialField } from "@infrawrench/plugin-base";
import { LAMBDA_CI_EXECUTOR } from "./ci-executor.js";
import { LambdaCloudClient } from "./client.js";
import { LOGO_SVG } from "./logo.js";
import { lambdaCloudRemediationCommands } from "./remediation.js";
import { RESOURCE_TYPES } from "./resource-types.js";
import { parseStatusFeed, statusFeed } from "./status-feed.js";

export const manifest = {
  id: "lambda-cloud",
  egressHosts: ["cloud.lambda.ai"],
  displayName: "Lambda Cloud",
  description:
    "GPU cloud. On-demand instances with live capacity and price pickers, launch, restart and terminate, persistent filesystems, firewall rulesets and SSH keys.",
  logoSvg: LOGO_SVG,
  credentialFields: defineCredentials([
    {
      key: "apiKey",
      label: "API Key",
      description:
        "A Lambda Cloud API key, from the Lambda Cloud dashboard's API keys page (cloud.lambda.ai/api-keys), Generate API key. Keys are team-wide and carry full access; Lambda shows the key only once.",
      sensitive: true,
      placeholder: "secret_…",
      helpLink: { label: "Lambda Cloud API keys", url: "https://cloud.lambda.ai/api-keys" },
    },
    caCertCredentialField,
  ]),
  statusFeed,
  // CI jobs on a fresh GPU instance (`cloud: lambda-cloud/vm`). See `ci-executor.ts`.
  ciExecutor: LAMBDA_CI_EXECUTOR,
} satisfies PluginManifest;

export type Credentials = CredentialsOf<typeof manifest>;

export const plugin = definePlugin({
  manifest,
  resourceTypes: RESOURCE_TYPES,
  createClient: (credentials, services) =>
    new LambdaCloudClient(credentials, RESOURCE_TYPES, services),
  testCredentials: { apiKey: "secret_test_key" },
  parseStatusFeed,
  remediationCommands: lambdaCloudRemediationCommands,
});
