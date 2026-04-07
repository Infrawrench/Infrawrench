import type { Plugin, PluginManifest, ResourceTypeDefinition, HostServices } from "@infrawrench/plugin-base";
import { KubernetesClient } from "./client.js";
import { KubernetesClusterResourceType } from "./resources/k8s-cluster.js";
import { NamespaceResourceType } from "./resources/namespace.js";
import { PodResourceType } from "./resources/pod.js";
import { DeploymentResourceType } from "./resources/deployment.js";

const manifest: PluginManifest = {
  id: "kubernetes",
  version: "0.1.0",
  displayName: "Kubernetes",
  description: "Manage Kubernetes clusters — connects via kubeconfig (literal or from a DOKS cluster).",
  logoSvg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
    <circle cx="50" cy="50" r="50" fill="#326CE5"/>
    <text x="50" y="65" font-size="48" text-anchor="middle" fill="white" font-family="sans-serif">⎈</text>
  </svg>`,
  author: "Infrawrench",
  license: "MIT",
  minHostVersion: "0.1.0",
  peerPlugins: ["digitalocean"],
  supportsSecretImport: true,
  credentialFields: [
    {
      key: "kubeconfig",
      label: "Kubeconfig",
      description: "Paste the contents of your kubeconfig YAML, or link this to a DOKS cluster after adding.",
      sensitive: true,
      multiline: true,
      placeholder: "apiVersion: v1\nkind: Config\n...",
    },
  ],
};

const resourceTypes: ResourceTypeDefinition[] = [
  KubernetesClusterResourceType,
  NamespaceResourceType,
  PodResourceType,
  DeploymentResourceType,
];

export const plugin: Plugin = {
  manifest,
  resourceTypes,
  createClient: (credentials, services) => new KubernetesClient(credentials, services),
};
