import type { Plugin, PluginManifest, ResourceTypeDefinition } from "@infrawrench/plugin-base";
import { OpenSearchClient } from "./client.js";
import { OpenSearchClusterResourceType } from "./resources/opensearch-cluster.js";

const manifest: PluginManifest = {
  id: "opensearch",
  version: "0.1.0",
  displayName: "OpenSearch",
  logoSvg: `<svg role="img" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path fill="#005EB8" d="M19.929 5.022a.516.516 0 0 0-.51.51c0 6.156-5.082 7.392-7.92 7.83-2.508.396-5.28 1.32-5.28 4.752a4.62 4.62 0 0 0 .768 2.508 9.96 9.96 0 0 0 13.464-13.488.51.51 0 0 0-.522-.112zM4.071 18.978a.516.516 0 0 0 .51-.51c0-6.156 5.082-7.392 7.92-7.83 2.508-.396 5.28-1.32 5.28-4.752a4.62 4.62 0 0 0-.768-2.508A9.96 9.96 0 0 0 3.549 18.866a.51.51 0 0 0 .522.112z"/></svg>`,
  author: "Infrawrench",
  minHostVersion: "0.1.0",
  credentialFields: [
    {
      key: "endpoint",
      label: "Endpoint",
      description: "Base URL of the OpenSearch cluster, e.g. https://search.example.com:9200",
      placeholder: "https://host:9200",
      sensitive: false,
    },
    {
      key: "authMode",
      label: "Auth Mode",
      description:
        "How to authenticate: basic (user+pass), apiKey, or awsSigv4 (AWS-managed OpenSearch).",
      placeholder: "basic",
      sensitive: false,
    },
    {
      key: "username",
      label: "Username",
      description: "Basic-auth username (only when Auth Mode is 'basic').",
      sensitive: false,
    },
    {
      key: "password",
      label: "Password",
      description: "Basic-auth password (only when Auth Mode is 'basic').",
      sensitive: true,
    },
    {
      key: "apiKey",
      label: "API Key",
      description: "Base64-encoded API key (only when Auth Mode is 'apiKey').",
      sensitive: true,
    },
    {
      key: "awsAccessKeyId",
      label: "AWS Access Key ID",
      description: "AWS access key for SigV4 signing (only when Auth Mode is 'awsSigv4').",
      sensitive: false,
    },
    {
      key: "awsSecretAccessKey",
      label: "AWS Secret Access Key",
      description: "AWS secret access key for SigV4 signing.",
      sensitive: true,
    },
    {
      key: "awsRegion",
      label: "AWS Region",
      description: "AWS region of the OpenSearch domain, e.g. us-east-1.",
      sensitive: false,
    },
    {
      key: "awsSessionToken",
      label: "AWS Session Token",
      description: "Optional temporary session token for SigV4 signing.",
      sensitive: true,
    },
    {
      key: "awsService",
      label: "AWS Service",
      description:
        "SigV4 service name. Defaults to 'es' (Amazon OpenSearch Service); use 'aoss' for Amazon OpenSearch Serverless.",
      sensitive: false,
    },
    {
      key: "caCertificate",
      label: "CA Certificate",
      description:
        "PEM-encoded CA certificate trusted by the host when verifying TLS. Required for self-signed clusters and DigitalOcean/OVH managed databases.",
      sensitive: false,
    },
    {
      key: "skipTlsVerify",
      label: "Skip TLS Verify",
      description:
        "When 'true', the host skips TLS chain verification. Only use with isolated dev clusters — never with production.",
      sensitive: false,
    },
  ],
};

const resourceTypes: ResourceTypeDefinition[] = [OpenSearchClusterResourceType];

export const plugin: Plugin = {
  manifest,
  resourceTypes,
  createClient: (credentials, services) => new OpenSearchClient(credentials, services),
};
