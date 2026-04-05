import type { Plugin, PluginManifest, ResourceTypeDefinition } from "@infrawrench/plugin-base";
import { DockerClient } from "./client.js";
import { DockerContainerResourceType } from "./resources/docker-container.js";

const manifest: PluginManifest = {
  id: "docker",
  version: "0.1.0",
  displayName: "Docker",
  description: "Manage Docker containers on a local or remote Docker daemon.",
  logoSvg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
    <rect width="100" height="100" rx="12" fill="#2496ED"/>
    <text x="50" y="68" font-size="48" text-anchor="middle" fill="white" font-family="monospace" font-weight="bold">D</text>
  </svg>`,
  author: "Infrawrench",
  license: "MIT",
  minHostVersion: "0.1.0",
  credentialFields: [
    {
      key: "dockerHost",
      label: "Docker Host",
      description: "Unix socket or TCP address for the Docker daemon.",
      sensitive: false,
      placeholder: "unix:///var/run/docker.sock",
      defaultValue: "unix:///var/run/docker.sock",
    },
  ],
  dockerDriver: {
    driver: "docker",
    credentialKey: "dockerHost",
  },
};

const resourceTypes: ResourceTypeDefinition[] = [
  DockerContainerResourceType,
];

export const plugin: Plugin = {
  manifest,
  resourceTypes,
  createClient: (credentials, services) => new DockerClient(credentials, services),
};
