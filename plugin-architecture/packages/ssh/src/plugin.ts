import { defineCredentials, definePlugin } from "@infrawrench/plugin-base";
import type {
  PluginManifest,
  ResourceTypeDefinition,
  CredentialsOf,
} from "@infrawrench/plugin-base";
import { SshClient } from "./client.js";
import { SshTargetResourceType } from "./resources/ssh-target.js";

export const manifest = {
  id: "ssh",
  egressHosts: [],
  displayName: "SSH",
  jumpHost: true,
  logoSvg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
    <rect width="100" height="100" rx="12" fill="#1a1a2e"/>
    <text x="50" y="62" font-size="34" text-anchor="middle" fill="#4ade80" font-family="monospace" font-weight="bold">&gt;_</text>
  </svg>`,
  credentialFields: defineCredentials([
    {
      key: "host",
      label: "Host",
      description: "Hostname or IP address of the SSH server.",
      sensitive: false,
      placeholder: "192.168.1.1",
    },
    {
      key: "port",
      label: "Port",
      description: "SSH port number.",
      sensitive: false,
      placeholder: "22",
      defaultValue: "22",
    },
    {
      key: "username",
      label: "Username",
      sensitive: false,
      placeholder: "root",
      defaultValue: "root",
    },
    {
      key: "privateKey",
      label: "Private Key",
      description: "PEM-encoded SSH private key (RSA, Ed25519, etc.).",
      sensitive: true,
      multiline: true,
      placeholder: "-----BEGIN OPENSSH PRIVATE KEY-----\n...",
    },
    {
      key: "connectThroughAccountId",
      label: "Connect through",
      description:
        "Optional. Route this SSH connection through another SSH account (jump host / bastion). Chains: the selected account may itself connect through another, and so on.",
      sensitive: false,
      optional: true,
      accountReference: { pluginId: "ssh" },
    },
  ]),
  // Lend the host to a CI job (`connections:` in a pipeline): an SSH config
  // entry named after the connection, its key and a pinned host key check.
  // See `ci-credential.ts`.
  ciCredential: {
    description:
      "An SSH config entry named after the connection, with its key and a check against the host key pinned in Infrawrench.",
    shortLived: false,
  },
} satisfies PluginManifest;

export type Credentials = CredentialsOf<typeof manifest>;

const resourceTypes: ResourceTypeDefinition[] = [SshTargetResourceType];

export const plugin = definePlugin({
  manifest,
  resourceTypes,
  createClient: (credentials) =>
    new SshClient(
      credentials as {
        host: string;
        port?: string;
        username?: string;
        privateKey?: string;
        connectThroughAccountId?: string;
      },
    ),
  testCredentials: {
    host: "192.168.1.1",
    port: "22",
    username: "root",
    privateKey: "-----BEGIN OPENSSH PRIVATE KEY-----\ntest\n-----END OPENSSH PRIVATE KEY-----",
  },
});
