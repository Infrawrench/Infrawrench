import type { Plugin, PluginManifest } from "@infrawrench/plugin-base";
import { caCertCredentialField } from "@infrawrench/plugin-base";
import { S3CompatibleClient } from "./client.js";
import { LOGO_SVG } from "./logo.js";
import { RESOURCE_TYPES } from "./resource-types.js";

const manifest: PluginManifest = {
  id: "s3-compatible",
  version: "0.1.0",
  displayName: "S3-Compatible Storage",
  description:
    "Any S3-compatible object store (MinIO, Ceph RGW, Garage, SeaweedFS and others). Browse and upload objects, manage buckets, policies, versioning, Object Lock, tags, lifecycle and CORS rules, and on MinIO see cluster health, servers, drives and usage.",
  logoSvg: LOGO_SVG,
  author: "Infrawrench",
  minHostVersion: "0.1.0",
  credentialFields: [
    {
      key: "endpoint",
      label: "Endpoint URL",
      description:
        "The S3 API address of your server, with the port if it is not 443: for MinIO usually https://minio.example.com:9000 (the API port, not the console port), for Ceph the RADOS Gateway URL.",
      sensitive: false,
      placeholder: "https://minio.example.com:9000",
    },
    {
      key: "region",
      label: "Region",
      description:
        "The region the server signs requests for. MinIO and Garage default to us-east-1 unless you configured another (MINIO_SITE_REGION, Garage's s3_region); Ceph uses its zonegroup name.",
      sensitive: false,
      optional: true,
      placeholder: "us-east-1",
      defaultValue: "us-east-1",
    },
    {
      key: "accessKey",
      label: "Access Key",
      description:
        "An access key for the server. On MinIO create one under Access Keys in the console (or `mc admin user svcacct add`); the root user also sees cluster health. On Ceph use `radosgw-admin user create`.",
      sensitive: false,
      placeholder: "minioadmin",
    },
    {
      key: "secretKey",
      label: "Secret Key",
      description: "The secret key paired with the access key.",
      sensitive: true,
    },
    {
      key: "addressing",
      label: "Addressing",
      description:
        "Path-style (https://host/bucket) works everywhere and is the default; pick virtual-hosted (https://bucket.host) only if your server requires it and has wildcard DNS and certificates.",
      sensitive: false,
      optional: true,
      advanced: true,
      defaultValue: "path",
      providerOptions: { dependsOn: ["endpoint"] },
    },
    {
      key: "sessionToken",
      label: "Session Token",
      description: "Only for temporary STS credentials.",
      sensitive: true,
      optional: true,
      advanced: true,
    },
    caCertCredentialField,
  ],
  preflight: {
    capabilities: [
      {
        id: "resources",
        label: "Buckets and objects",
        essential: true,
        requiredPermissions: [{ id: "s3:ListAllMyBuckets", label: "List buckets" }],
      },
      {
        id: "minio-admin",
        label: "MinIO cluster health",
        description: "Only on MinIO: server, drive and usage information from the admin API.",
        requiredPermissions: [{ id: "admin:ServerInfo", label: "Read server info" }],
      },
    ],
  },
  rateLimit: { capacity: 20, refillPerSecond: 10 },
};

export const plugin: Plugin = {
  manifest,
  resourceTypes: RESOURCE_TYPES,
  createClient: (credentials, services) => new S3CompatibleClient(credentials, services),
  listCredentialOptions: async (fieldKey) => {
    if (fieldKey !== "addressing") return [];
    return [
      { id: "path", label: "Path-style", description: "https://host/bucket" },
      { id: "virtual", label: "Virtual-hosted", description: "https://bucket.host" },
    ];
  },
};
