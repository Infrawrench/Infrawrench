import type { Plugin, PluginManifest, ResourceTypeDefinition } from "@infrawrench/plugin-base";
import { AzureClient } from "./client.js";
import { VMResourceType } from "./resources/vm.js";
import { DiskResourceType } from "./resources/disk.js";
import { VNetResourceType } from "./resources/vnet.js";
import { AKSClusterResourceType } from "./resources/aks-cluster.js";
import { SQLDatabaseResourceType } from "./resources/sql-database.js";
import { CosmosDBAccountResourceType } from "./resources/cosmos-db.js";
import { StorageAccountResourceType } from "./resources/storage-account.js";
import { FunctionAppResourceType } from "./resources/function-app.js";
import { AppServiceResourceType } from "./resources/app-service.js";
import { ContainerInstanceResourceType } from "./resources/container-instance.js";
import { KeyVaultResourceType } from "./resources/key-vault.js";
import { RedisCacheResourceType } from "./resources/redis-cache.js";
import { ServiceBusNamespaceResourceType } from "./resources/service-bus.js";
import { ContainerRegistryResourceType } from "./resources/container-registry.js";
import { LoadBalancerResourceType } from "./resources/load-balancer.js";
import { DNSZoneResourceType } from "./resources/dns-zone.js";
import { ResourceGroupResourceType } from "./resources/resource-group.js";
import { NSGResourceType } from "./resources/nsg.js";
import { PublicIPResourceType } from "./resources/public-ip.js";
import { PostgresFlexibleServerResourceType } from "./resources/postgres-flexible.js";
import { MySQLFlexibleServerResourceType } from "./resources/mysql-flexible.js";
import { EventHubNamespaceResourceType } from "./resources/event-hub.js";
import { AppGatewayResourceType } from "./resources/app-gateway.js";
import { LogAnalyticsWorkspaceResourceType } from "./resources/log-analytics.js";
import { ManagedIdentityResourceType } from "./resources/managed-identity.js";
import { FirewallResourceType } from "./resources/firewall.js";

const manifest: PluginManifest = {
  id: "azure",
  version: "0.1.0",
  displayName: "Microsoft Azure",
  description: "Manage Azure cloud infrastructure — VMs, AKS, SQL, Cosmos DB, Storage, Functions, and more",
  logoSvg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
    <rect width="100" height="100" rx="12" fill="#0078D4"/>
    <g transform="translate(18,20) scale(0.65)">
      <path d="M35.5 10L13 80h18.4L60.5 10H35.5z" fill="#fff" opacity="0.8"/>
      <path d="M50 30l-18 50h35l25-16H50z" fill="#fff"/>
      <path d="M50 30l18.5 34H92L50 30z" fill="#fff" opacity="0.6"/>
    </g>
  </svg>`,
  author: "Infrawrench",
  license: "MIT",
  minHostVersion: "0.1.0",
  credentialFields: [
    {
      key: "tenantId",
      label: "Tenant ID",
      description: "Azure Active Directory tenant (directory) ID.",
      sensitive: false,
      placeholder: "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
    },
    {
      key: "clientId",
      label: "Client ID",
      description: "Application (client) ID of the Azure AD service principal.",
      sensitive: false,
      placeholder: "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
    },
    {
      key: "clientSecret",
      label: "Client Secret",
      description: "Client secret for the service principal.",
      sensitive: true,
      placeholder: "Secret value...",
    },
    {
      key: "subscriptionId",
      label: "Subscription ID",
      description: "Azure subscription to manage.",
      sensitive: false,
      placeholder: "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
    },
  ],
};

const resourceTypes: ResourceTypeDefinition[] = [
  ResourceGroupResourceType,
  VMResourceType,
  DiskResourceType,
  VNetResourceType,
  AKSClusterResourceType,
  SQLDatabaseResourceType,
  CosmosDBAccountResourceType,
  StorageAccountResourceType,
  FunctionAppResourceType,
  AppServiceResourceType,
  ContainerInstanceResourceType,
  KeyVaultResourceType,
  RedisCacheResourceType,
  ServiceBusNamespaceResourceType,
  ContainerRegistryResourceType,
  LoadBalancerResourceType,
  DNSZoneResourceType,
  NSGResourceType,
  PublicIPResourceType,
  PostgresFlexibleServerResourceType,
  MySQLFlexibleServerResourceType,
  EventHubNamespaceResourceType,
  AppGatewayResourceType,
  LogAnalyticsWorkspaceResourceType,
  ManagedIdentityResourceType,
  FirewallResourceType,
];

export const plugin: Plugin = {
  manifest,
  resourceTypes,
  createClient: (credentials) => new AzureClient(credentials),
};
