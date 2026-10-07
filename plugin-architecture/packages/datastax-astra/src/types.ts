/** Wire shapes from the Astra DevOps and streaming OpenAPI documents (2026-10). */

export interface AstraDatacenter {
  id?: string;
  name?: string;
  tier?: string;
  status?: string;
  cloudProvider?: string;
  region?: string;
  regionZone?: string;
  regionClassification?: string;
  capacityUnits?: number;
  pcuGroupUUID?: string;
  dataEndpointUrl?: string;
  cqlshUrl?: string;
  grafanaUrl?: string;
  secureBundleUrl?: string;
}

export interface AstraDatabase {
  id: string;
  orgId?: string;
  ownerId?: string;
  info?: {
    name?: string;
    keyspace?: string;
    cloudProvider?: string;
    tier?: string;
    capacityUnits?: number;
    region?: string;
    datacenters?: AstraDatacenter[];
    additionalKeyspaces?: string[];
    keyspaces?: string[];
    dbType?: string;
  };
  creationTime?: string;
  terminationTime?: string;
  status?: string;
  storage?: {
    nodeCount?: number;
    replicationFactor?: number;
    totalStorage?: number;
    usedStorage?: number;
  };
  availableActions?: string[];
  message?: string;
  studioUrl?: string;
  grafanaUrl?: string;
  cqlshUrl?: string;
  dataEndpointUrl?: string;
  dbType?: string;
}

export interface AstraRegion {
  cloudProvider?: string;
  name: string;
  displayName?: string;
  zone?: string;
  classification?: string;
  region_type?: string;
  enabled?: boolean;
  reservedForQualifiedUsers?: boolean;
}

export interface AstraAccessList {
  organizationId?: string;
  databaseId?: string;
  addresses?: Array<{
    address?: string;
    enabled?: boolean;
    description?: string;
    lastUpdateDateTime?: string;
  }>;
  configurations?: { accessListEnabled?: boolean };
}

export interface AstraPolicy {
  description?: string;
  resources?: string[];
  actions?: string[];
  effect?: string;
}

export interface AstraRole {
  id?: string;
  name?: string;
  policy?: AstraPolicy;
  last_update_datetime?: string;
  last_update_userid?: string;
}

export interface AstraUser {
  userID: string;
  email?: string;
  status?: string;
  roles?: AstraRole[];
}

export interface AstraClient {
  clientId?: string;
  roles?: string[];
  generatedOn?: string;
}

export interface AstraPcuGroup {
  uuid: string;
  orgId?: string;
  title?: string;
  cloudProvider?: string;
  region?: string;
  instanceType?: string;
  provisionType?: string;
  min?: number;
  max?: number;
  reserved?: number;
  description?: string;
  createdAt?: string;
  updatedAt?: string;
  createdBy?: string;
  status?: string;
}

export interface AstraPcuAssociation {
  datacenterUUID?: string;
  pcuGroupUUID?: string;
  provisioningStatus?: string;
}

export interface AstraTenant {
  id?: string;
  tenantName?: string;
  clusterName?: string;
  cloudProvider?: string;
  cloudProviderCode?: string;
  cloudRegion?: string;
  plan?: string;
  status?: string;
  pulsarVersion?: string;
  brokerServiceUrl?: string;
  webServiceUrl?: string;
  websocketUrl?: string;
  userMetricsUrl?: string;
  astraOrgGUID?: string;
}

export interface AstraStreamingCluster {
  clusterName?: string;
  cloudProvider?: string;
  cloudRegion?: string;
  clusterType?: string;
}

export interface AstraPrivateLinkOrg {
  clusters?: Array<{
    clusterID?: string;
    datacenters?: Array<{
      serviceName?: string;
      allowedPrincipals?: string[];
      datacenterID?: string;
      endpoints?: Array<{
        endpointID?: string;
        description?: string;
        linkID?: string;
        status?: string;
        createdDateTime?: string;
      }>;
    }>;
  }>;
}

export interface AstraCdc {
  databaseID?: string;
  databaseName?: string;
  tables?: Array<{ tableName?: string; keyspaceName?: string }>;
  regions?: Array<{
    datacenterID?: string;
    datacenterRegion?: string;
    streamingClusterName?: string;
    streamingTenantName?: string;
  }>;
}

export interface AstraCollection {
  name: string;
  options?: {
    vector?: {
      dimension?: number;
      metric?: string;
      sourceModel?: string;
      service?: { provider?: string; modelName?: string };
    };
    defaultId?: { type?: string };
    lexical?: { enabled?: boolean; analyzer?: string };
    rerank?: { enabled?: boolean; service?: { provider?: string; modelName?: string } };
  };
}
