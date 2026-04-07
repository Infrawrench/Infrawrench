import type { Plugin, PluginManifest, ResourceTypeDefinition } from "@infrawrench/plugin-base";
import { GcpClient } from "./client.js";
import { GceInstanceResourceType } from "./resources/gce-instance.js";
import { GceDiskResourceType } from "./resources/gce-disk.js";
import { GkeClusterResourceType } from "./resources/gke-cluster.js";
import { CloudSqlInstanceResourceType } from "./resources/cloudsql-instance.js";
import { SpannerInstanceResourceType } from "./resources/spanner-instance.js";
import { BigtableInstanceResourceType } from "./resources/bigtable-instance.js";
import { FirestoreDatabaseResourceType } from "./resources/firestore-database.js";
import { MemorystoreRedisResourceType } from "./resources/memorystore-redis.js";
import { AlloyDbClusterResourceType } from "./resources/alloydb-cluster.js";
import { GcsBucketResourceType } from "./resources/gcs-bucket.js";
import { PubSubTopicResourceType } from "./resources/pubsub-topic.js";
import { PubSubSubscriptionResourceType } from "./resources/pubsub-subscription.js";
import { CloudRunServiceResourceType } from "./resources/cloud-run-service.js";
import { CloudFunctionResourceType } from "./resources/cloud-function.js";
import { VpcNetworkResourceType } from "./resources/vpc-network.js";
import { BigQueryDatasetResourceType } from "./resources/bigquery-dataset.js";
import { ArtifactRegistryRepoResourceType } from "./resources/artifact-registry-repo.js";
import { ServiceAccountResourceType } from "./resources/service-account.js";
import { CloudArmorPolicyResourceType } from "./resources/cloud-armor-policy.js";
import { SecretManagerSecretResourceType } from "./resources/secret-manager-secret.js";
import { DataflowJobResourceType } from "./resources/dataflow-job.js";

const manifest: PluginManifest = {
  id: "gcp",
  version: "0.1.0",
  displayName: "Google Cloud",
  description: "Manage Google Cloud resources: Compute, GKE, Cloud SQL, Cloud Run, Storage, BigQuery, and more.",
  logoSvg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
    <rect width="100" height="100" rx="12" fill="#4285F4"/>
    <g transform="translate(12,12) scale(3.167)" fill="white">
      <path d="M12.19 2.38a9.344 9.344 0 0 0-9.234 6.893c.053-.02-.055.013 0 0-3.875 2.551-3.922 8.11-.247 10.941l.006-.007-.007.03a6.717 6.717 0 0 0 4.077 1.356h5.173l.03.03h5.192c6.687.053 9.376-8.605 3.835-12.35a9.365 9.365 0 0 0-2.821-4.552l-.043.043.006-.05A9.344 9.344 0 0 0 12.19 2.38zm-.358 4.146c1.244-.04 2.518.368 3.486 1.15a5.186 5.186 0 0 1 1.862 4.078v.518c3.53-.07 3.53 5.262 0 5.193h-5.193l-.008.009v-.04H6.785a2.59 2.59 0 0 1-1.067-.23h.001a2.597 2.597 0 1 1 3.437-3.437l3.013-3.012A6.747 6.747 0 0 0 8.11 8.24c.018-.01.04-.026.054-.023a5.186 5.186 0 0 1 3.67-1.69z"/>
    </g>
  </svg>`,
  author: "Infrawrench",
  license: "MIT",
  minHostVersion: "0.1.0",
  credentialFields: [
    {
      key: "serviceAccountJson",
      label: "Service Account Key (JSON)",
      description: "Paste the full contents of a GCP service account key JSON file. The account needs the Viewer role or equivalent read permissions.",
      sensitive: true,
      multiline: true,
      placeholder: '{"type":"service_account","project_id":"my-project",...}',
    },
    {
      key: "project",
      label: "Project ID (optional)",
      description: "Override the project ID from the service account JSON. Leave blank to use the project in the key file.",
      sensitive: false,
      placeholder: "my-gcp-project",
    },
  ],
};

const resourceTypes: ResourceTypeDefinition[] = [
  // Compute
  GceInstanceResourceType,
  GceDiskResourceType,
  // Kubernetes
  GkeClusterResourceType,
  // Databases
  CloudSqlInstanceResourceType,
  SpannerInstanceResourceType,
  BigtableInstanceResourceType,
  FirestoreDatabaseResourceType,
  MemorystoreRedisResourceType,
  AlloyDbClusterResourceType,
  // Storage & Messaging
  GcsBucketResourceType,
  PubSubTopicResourceType,
  PubSubSubscriptionResourceType,
  // Serverless
  CloudRunServiceResourceType,
  CloudFunctionResourceType,
  // Networking & Security
  VpcNetworkResourceType,
  CloudArmorPolicyResourceType,
  // Data
  BigQueryDatasetResourceType,
  DataflowJobResourceType,
  // Developer Tools
  ArtifactRegistryRepoResourceType,
  // IAM
  ServiceAccountResourceType,
  // Secrets
  SecretManagerSecretResourceType,
];

export const plugin: Plugin = {
  manifest,
  resourceTypes,
  createClient: (credentials) => new GcpClient(credentials),
};
