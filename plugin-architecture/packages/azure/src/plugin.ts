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
  description:
    "Manage Azure cloud infrastructure — VMs, AKS, SQL, Cosmos DB, Storage, Functions, and more",
  logoSvg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
    <rect width="100" height="100" rx="12" fill="#0078D4"/>
    <g transform="translate(10,6) scale(3.33)" fill="#fff">
      <path d="M22.379 23.343a1.62 1.62 0 0 0 1.536-2.14v.002L17.35 1.76A1.62 1.62 0 0 0 15.816.657H8.184A1.62 1.62 0 0 0 6.65 1.76L.086 21.204a1.62 1.62 0 0 0 1.536 2.139h4.741a1.62 1.62 0 0 0 1.535-1.103l.977-2.892 4.947 3.675c.28.208.618.32.966.32m-3.084-12.531 3.624 10.739a.54.54 0 0 1-.51.713v-.001h-.03a.54.54 0 0 1-.322-.106l-9.287-6.9h4.853m6.313 7.006c.116-.326.13-.694.007-1.058L9.79 1.76a1.722 1.722 0 0 0-.007-.02h6.034a.54.54 0 0 1 .512.366l6.562 19.445a.54.54 0 0 1-.338.684"/>
    </g>
  </svg>`,
  author: "Infrawrench",
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
  createClient: (credentials) => new AzureClient(credentials, resourceTypes),
};
