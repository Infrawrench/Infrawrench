import type { Plugin, PluginManifest, ResourceTypeDefinition } from "@infrawrench/plugin-base";
import { DigitalOceanClient } from "./client.js";
import { ProjectResourceType } from "./resources/project.js";
import { DropletResourceType } from "./resources/droplet.js";
import { DOKSClusterResourceType } from "./resources/doks-cluster.js";
import { ManagedDatabaseResourceType } from "./resources/managed-database.js";
import { DatabaseUserResourceType } from "./resources/db-user.js";
import { SpacesResourceType } from "./resources/spaces.js";
import { DomainResourceType } from "./resources/domain.js";
import { DnsRecordResourceType } from "./resources/dns-record.js";
import { VolumeResourceType } from "./resources/volume.js";
import { SnapshotResourceType } from "./resources/snapshot.js";
import { ImageResourceType } from "./resources/image.js";
import { NfsShareResourceType } from "./resources/nfs-share.js";
import { GenAiAgentResourceType } from "./resources/gen-ai-agent.js";
import { GenAiKnowledgeBaseResourceType } from "./resources/gen-ai-knowledge-base.js";
import { GenAiModelRouterResourceType } from "./resources/gen-ai-model-router.js";
import { DedicatedInferenceResourceType } from "./resources/dedicated-inference.js";
import { InferenceBatchResourceType } from "./resources/inference-batch.js";
import { ModelApiKeyResourceType } from "./resources/model-api-key.js";
import { AgentApiKeyResourceType } from "./resources/agent-api-key.js";

const manifest: PluginManifest = {
  id: "digitalocean",
  version: "0.1.0",
  displayName: "DigitalOcean",
  logoSvg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
    <rect width="100" height="100" rx="12" fill="#0080FF"/>
    <g transform="translate(12,12) scale(3.167)" fill="white">
      <path d="M12.04 0C5.408-.02.005 5.37.005 11.992h4.638c0-4.923 4.882-8.731 10.064-6.855a6.95 6.95 0 014.147 4.148c1.889 5.177-1.924 10.055-6.84 10.064v-4.61H7.391v4.623h4.61V24c7.86 0 13.967-7.588 11.397-15.83-1.115-3.59-3.985-6.446-7.575-7.575A12.8 12.8 0 0012.039 0zM7.39 19.362H3.828v3.564H7.39zm-3.563 0v-2.978H.85v2.978z"/>
    </g>
  </svg>`,
  author: "Infrawrench",
  minHostVersion: "0.1.0",
  credentialFields: [
    {
      key: "apiToken",
      label: "API Token",
      description: "A DigitalOcean personal access token with read scope.",
      sensitive: true,
      placeholder: "dop_v1_...",
    },
    {
      key: "spacesAccessKeyId",
      label: "Spaces Access Key ID",
      description:
        "Optional S3-compatible Spaces access key. Required to list and manage existing Spaces buckets; bucket creation can auto-mint one when the API token has spaces_key:create_credentials.",
      sensitive: true,
      optional: true,
      placeholder: "DO00...",
    },
    {
      key: "spacesSecretAccessKey",
      label: "Spaces Secret Access Key",
      description:
        "Optional S3-compatible Spaces secret key. Stored encrypted and used only for Spaces bucket/object operations.",
      sensitive: true,
      optional: true,
      placeholder: "secret shown once by DigitalOcean",
    },
  ],
  rateLimit: { capacity: 60, refillPerSecond: 4 },
};

const resourceTypes: ResourceTypeDefinition[] = [
  ProjectResourceType,
  DropletResourceType,
  DOKSClusterResourceType,
  ManagedDatabaseResourceType,
  DatabaseUserResourceType,
  SpacesResourceType,
  DomainResourceType,
  DnsRecordResourceType,
  VolumeResourceType,
  SnapshotResourceType,
  ImageResourceType,
  NfsShareResourceType,
  GenAiAgentResourceType,
  GenAiKnowledgeBaseResourceType,
  GenAiModelRouterResourceType,
  DedicatedInferenceResourceType,
  InferenceBatchResourceType,
  ModelApiKeyResourceType,
  AgentApiKeyResourceType,
];

export const plugin: Plugin = {
  manifest,
  resourceTypes,
  createClient: (credentials, services) =>
    new DigitalOceanClient(credentials, resourceTypes, services),
};
