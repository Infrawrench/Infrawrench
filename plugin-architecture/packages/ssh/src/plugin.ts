import type { Plugin, PluginManifest, ResourceTypeDefinition } from "@infrawrench/plugin-base";
import { SshClient } from "./client.js";
import { SshTargetResourceType } from "./resources/ssh-target.js";

const manifest: PluginManifest = {
  id: "ssh",
  version: "0.1.0",
  displayName: "SSH",
  description: "Connect to remote servers via SSH with a full terminal.",
  logoSvg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
    <rect width="100" height="100" rx="12" fill="#1a1a2e"/>
    <text x="50" y="62" font-size="34" text-anchor="middle" fill="#4ade80" font-family="monospace" font-weight="bold">&gt;_</text>
  </svg>`,
  author: "Infrawrench",
  license: "MIT",
  minHostVersion: "0.1.0",
  credentialFields: [
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
  ],
};

const resourceTypes: ResourceTypeDefinition[] = [SshTargetResourceType];

export const plugin: Plugin = {
  manifest,
  resourceTypes,
  createClient: (credentials) =>
    new SshClient(credentials as { host: string; port?: string; username?: string; privateKey?: string }),
};
