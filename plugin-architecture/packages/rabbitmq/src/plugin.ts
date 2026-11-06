import { defineCredentials, definePlugin } from "@infrawrench/plugin-base";
import type { PluginManifest, CredentialsOf } from "@infrawrench/plugin-base";
import { caCertCredentialField } from "@infrawrench/plugin-base";
import { RABBIT_PREFLIGHT, RabbitClient } from "./client.js";
import { LOGO_SVG } from "./logo.js";
import { rabbitmqRemediationCommands } from "./remediation.js";
import { RESOURCE_TYPES } from "./resource-types.js";
import { rabbitTerraformExport } from "./terraform.js";

export const manifest = {
  id: "rabbitmq",
  // RabbitMQ is self-hosted: the management URL is user-supplied, so there is no fixed egress host (same as kubernetes).
  egressHosts: [],
  displayName: "RabbitMQ",
  description:
    "Self-hosted RabbitMQ through the management API: virtual hosts, exchanges, queues with purge and message peek, bindings, editable policies, users and permissions, connections and channels, shovels and federation, node metrics, and publishing test messages.",
  logoSvg: LOGO_SVG,
  credentialFields: defineCredentials([
    {
      key: "url",
      label: "Management API URL",
      description:
        "Where the management plugin listens, including the port: http://mq.example.com:15672 or https://mq.example.com:15671 (rabbitmq-plugins enable rabbitmq_management). For a broker on a private network, add an SSH tunnel or a bastion to this account.",
      sensitive: false,
      placeholder: "https://mq.example.com:15671",
    },
    {
      key: "username",
      label: "Username",
      description:
        "A user with the administrator tag manages everything; monitoring or policymaker users see less (Check credentials shows what). Create one with rabbitmqctl add_user infrawrench <password> && rabbitmqctl set_user_tags infrawrench administrator && rabbitmqctl set_permissions -p / infrawrench '.*' '.*' '.*'. The guest user only signs in from localhost.",
      sensitive: false,
      optional: true,
      placeholder: "infrawrench",
    },
    {
      key: "password",
      label: "Password",
      sensitive: true,
      optional: true,
      placeholder: "••••••••",
    },
    {
      key: "token",
      label: "OAuth 2 Access Token",
      description:
        "Only when the broker uses rabbitmq_auth_backend_oauth2 instead of internal users: a JWT from your identity provider, sent as a bearer token. Leave empty to use the username and password.",
      sensitive: true,
      optional: true,
      advanced: true,
      placeholder: "eyJhbGciOi…",
    },
    caCertCredentialField,
  ]),
  preflight: RABBIT_PREFLIGHT,
  quotas: { label: "Limits", partial: true },
  rateLimit: { capacity: 20, refillPerSecond: 10 },
} satisfies PluginManifest;

export type Credentials = CredentialsOf<typeof manifest>;

export const plugin = definePlugin({
  manifest,
  resourceTypes: RESOURCE_TYPES,
  createClient: (credentials, services) => new RabbitClient(credentials, services),
  testCredentials: {
    url: "https://mq.example.com:15671",
    username: "infrawrench",
    password: "test",
  },
  terraformExport: rabbitTerraformExport,
  remediationCommands: rabbitmqRemediationCommands,
});
