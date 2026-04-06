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
    <rect width="100" height="100" rx="12" fill="#fff"/>
    <path d="M50 22l16 9.2v18.4L50 58.8 34 49.6V31.2L50 22z" fill="#EA4335"/>
    <path d="M66 31.2v18.4L50 58.8V40.4L66 31.2z" fill="#FBBC04"/>
    <path d="M50 40.4v18.4L34 49.6V31.2L50 40.4z" fill="#4285F4"/>
    <path d="M34 49.6l16 9.2 16-9.2-16 9.2z" fill="#34A853"/>
    <path d="M26 62h48v8H26z" fill="#4285F4"/>
    <path d="M26 74h12v6H26z" fill="#EA4335"/>
    <path d="M44 74h12v6H44z" fill="#FBBC04"/>
    <path d="M62 74h12v6H62z" fill="#34A853"/>
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
