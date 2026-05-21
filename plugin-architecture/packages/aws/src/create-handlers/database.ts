import type { CreateResourceConfig, ResourceInstance } from "@infrawrench/plugin-base";
import { fetchSigned } from "../signed-request.js";
import { AWS_REGIONS } from "../constants.js";
import type { AwsCreateContext } from "./shared.js";

export async function databaseGetCreateConfig(
  ctx: AwsCreateContext,
  typeId: string,
  _parentResourceId?: string,
): Promise<CreateResourceConfig | null> {
  if (typeId === "dynamodb-table") {
    return {
      fields: [
        { key: "tableName", label: "Table Name", kind: "text", required: true },
        {
          key: "region",
          label: "Region",
          kind: "region-picker",
          required: true,
          regions: AWS_REGIONS,
          defaultValue: ctx.creds.region,
        },
        {
          key: "partitionKey",
          label: "Partition Key",
          kind: "text",
          required: true,
          description: "Primary key attribute name",
        },
        {
          key: "partitionKeyType",
          label: "Partition Key Type",
          kind: "select",
          required: true,
          options: [
            { id: "S", label: "String" },
            { id: "N", label: "Number" },
            { id: "B", label: "Binary" },
          ],
          defaultValue: "S",
        },
        {
          key: "sortKey",
          label: "Sort Key",
          kind: "text",
          required: false,
          description: "Optional sort key attribute name",
        },
        {
          key: "sortKeyType",
          label: "Sort Key Type",
          kind: "select",
          required: false,
          options: [
            { id: "S", label: "String" },
            { id: "N", label: "Number" },
            { id: "B", label: "Binary" },
          ],
          defaultValue: "S",
        },
        {
          key: "billingMode",
          label: "Billing Mode",
          kind: "select",
          required: true,
          options: [
            { id: "PAY_PER_REQUEST", label: "On-demand" },
            { id: "PROVISIONED", label: "Provisioned" },
          ],
          defaultValue: "PAY_PER_REQUEST",
        },
        {
          // Optional JSON blob describing GSIs and LSIs at creation time. LSIs
          // are only configurable at create time (DynamoDB rule), so users who
          // want them have to supply them here; GSIs can also be added/removed
          // later via the Schema & indexes tab on the detail page.
          key: "secondaryIndexesJson",
          label: "Secondary indexes (optional)",
          kind: "text",
          required: false,
          multiline: true,
          description:
            'Optional JSON for GSIs/LSIs. Leave blank to skip. Schema: { "gsis": [{ "name": "byEmail", "partitionKey": "email", "partitionKeyType": "S", "sortKey": "createdAt", "sortKeyType": "S", "projection": "ALL" }], "lsis": [{ "name": "bySortAttr", "sortKey": "score", "sortKeyType": "N", "projection": "KEYS_ONLY" }] }. LSIs are creation-only — they cannot be added later.',
          placeholder: '{ "gsis": [], "lsis": [] }',
        },
      ],
    };
  }
  if (typeId === "rds-instance") {
    return {
      fields: [
        { key: "dbInstanceId", label: "DB Instance Identifier", kind: "text", required: true },
        {
          key: "region",
          label: "Region",
          kind: "region-picker",
          required: true,
          regions: AWS_REGIONS,
          defaultValue: ctx.creds.region,
        },
        {
          key: "engine",
          label: "Engine",
          kind: "select",
          required: true,
          options: [
            { id: "postgres", label: "PostgreSQL" },
            { id: "mysql", label: "MySQL" },
            { id: "mariadb", label: "MariaDB" },
            { id: "aurora-postgresql", label: "Aurora PostgreSQL" },
            { id: "aurora-mysql", label: "Aurora MySQL" },
          ],
          defaultValue: "postgres",
        },
        {
          key: "instanceClass",
          label: "Instance Class",
          kind: "select",
          required: true,
          options: [
            { id: "db.t3.micro", label: "db.t3.micro (2 vCPU, 1 GB)" },
            { id: "db.t3.small", label: "db.t3.small (2 vCPU, 2 GB)" },
            { id: "db.t3.medium", label: "db.t3.medium (2 vCPU, 4 GB)" },
            { id: "db.t3.large", label: "db.t3.large (2 vCPU, 8 GB)" },
            { id: "db.r6g.large", label: "db.r6g.large (2 vCPU, 16 GB)" },
            { id: "db.r6g.xlarge", label: "db.r6g.xlarge (4 vCPU, 32 GB)" },
          ],
          defaultValue: "db.t3.micro",
        },
        {
          key: "allocatedStorage",
          label: "Storage (GB)",
          kind: "number",
          required: true,
          defaultValue: "20",
          minValue: 20,
          maxValue: 65536,
        },
        {
          key: "masterUsername",
          label: "Master Username",
          kind: "text",
          required: true,
          defaultValue: "admin",
        },
        { key: "masterPassword", label: "Master Password", kind: "text", required: true },
        {
          key: "network",
          label: "VPC Network",
          kind: "resource-picker",
          required: false,
          description: "VPC network for the RDS instance",
          associationSources: [{ pluginId: "aws", resourceTypeId: "vpc", outputKey: "vpcId" }],
        },
      ],
    };
  }
  if (typeId === "elasticache-cluster") {
    return {
      fields: [
        { key: "cacheClusterId", label: "Cluster ID", kind: "text", required: true },
        {
          key: "region",
          label: "Region",
          kind: "region-picker",
          required: true,
          regions: AWS_REGIONS,
          defaultValue: ctx.creds.region,
        },
        {
          key: "engine",
          label: "Engine",
          kind: "select",
          required: true,
          options: [
            { id: "redis", label: "Redis" },
            { id: "memcached", label: "Memcached" },
          ],
          defaultValue: "redis",
        },
        {
          key: "cacheNodeType",
          label: "Node Type",
          kind: "select",
          required: true,
          options: [
            { id: "cache.t3.micro", label: "cache.t3.micro" },
            { id: "cache.t3.small", label: "cache.t3.small" },
            { id: "cache.t3.medium", label: "cache.t3.medium" },
            { id: "cache.r6g.large", label: "cache.r6g.large" },
            { id: "cache.r6g.xlarge", label: "cache.r6g.xlarge" },
          ],
          defaultValue: "cache.t3.micro",
        },
        {
          key: "numCacheNodes",
          label: "Number of Nodes",
          kind: "number",
          required: true,
          defaultValue: "1",
          minValue: 1,
          maxValue: 40,
        },
      ],
    };
  }
  if (typeId === "rds-cluster") {
    return {
      fields: [
        { key: "dbClusterIdentifier", label: "Cluster Identifier", kind: "text", required: true },
        {
          key: "region",
          label: "Region",
          kind: "region-picker",
          required: true,
          regions: AWS_REGIONS,
          defaultValue: ctx.creds.region,
        },
        {
          key: "engine",
          label: "Engine",
          kind: "select",
          required: true,
          options: [
            { id: "aurora-postgresql", label: "Aurora PostgreSQL" },
            { id: "aurora-mysql", label: "Aurora MySQL" },
          ],
          defaultValue: "aurora-postgresql",
        },
        {
          key: "masterUsername",
          label: "Master Username",
          kind: "text",
          required: true,
          defaultValue: "admin",
        },
        { key: "masterPassword", label: "Master Password", kind: "text", required: true },
      ],
    };
  }
  if (typeId === "redshift-cluster") {
    return {
      fields: [
        { key: "clusterIdentifier", label: "Cluster Identifier", kind: "text", required: true },
        {
          key: "region",
          label: "Region",
          kind: "region-picker",
          required: true,
          regions: AWS_REGIONS,
          defaultValue: ctx.creds.region,
        },
        {
          key: "nodeType",
          label: "Node Type",
          kind: "select",
          required: true,
          options: [
            { id: "dc2.large", label: "dc2.large" },
            { id: "dc2.8xlarge", label: "dc2.8xlarge" },
            { id: "ra3.xlplus", label: "ra3.xlplus" },
            { id: "ra3.4xlarge", label: "ra3.4xlarge" },
            { id: "ra3.16xlarge", label: "ra3.16xlarge" },
          ],
          defaultValue: "dc2.large",
        },
        {
          key: "masterUsername",
          label: "Master Username",
          kind: "text",
          required: true,
          defaultValue: "admin",
        },
        { key: "masterPassword", label: "Master Password", kind: "text", required: true },
        {
          key: "numberOfNodes",
          label: "Number of Nodes",
          kind: "number",
          required: true,
          defaultValue: "1",
          minValue: 1,
          maxValue: 128,
        },
      ],
    };
  }
  if (typeId === "opensearch-domain") {
    return {
      fields: [
        { key: "domainName", label: "Domain Name", kind: "text", required: true },
        {
          key: "region",
          label: "Region",
          kind: "region-picker",
          required: true,
          regions: AWS_REGIONS,
          defaultValue: ctx.creds.region,
        },
        {
          key: "engineVersion",
          label: "Engine Version",
          kind: "select",
          required: true,
          options: [
            { id: "OpenSearch_3.5", label: "OpenSearch 3.5" },
            { id: "OpenSearch_3.3", label: "OpenSearch 3.3" },
            { id: "OpenSearch_3.1", label: "OpenSearch 3.1" },
            { id: "OpenSearch_2.19", label: "OpenSearch 2.19" },
            { id: "OpenSearch_2.17", label: "OpenSearch 2.17" },
            { id: "Elasticsearch_7.10", label: "Elasticsearch 7.10 (legacy)" },
          ],
          defaultValue: "OpenSearch_3.5",
        },
        {
          key: "instanceType",
          label: "Instance Type",
          kind: "select",
          required: true,
          options: [
            { id: "t3.small.search", label: "t3.small.search" },
            { id: "t3.medium.search", label: "t3.medium.search" },
            { id: "m6g.large.search", label: "m6g.large.search" },
            { id: "r6g.large.search", label: "r6g.large.search" },
          ],
          defaultValue: "t3.small.search",
        },
        {
          key: "instanceCount",
          label: "Instance Count",
          kind: "number",
          required: true,
          defaultValue: "1",
          minValue: 1,
          maxValue: 80,
        },
      ],
    };
  }
  if (typeId === "neptune-cluster") {
    return {
      fields: [
        { key: "dbClusterIdentifier", label: "Cluster Identifier", kind: "text", required: true },
        {
          key: "region",
          label: "Region",
          kind: "region-picker",
          required: true,
          regions: AWS_REGIONS,
          defaultValue: ctx.creds.region,
        },
      ],
    };
  }
  if (typeId === "documentdb-cluster") {
    return {
      fields: [
        { key: "dbClusterIdentifier", label: "Cluster Identifier", kind: "text", required: true },
        {
          key: "region",
          label: "Region",
          kind: "region-picker",
          required: true,
          regions: AWS_REGIONS,
          defaultValue: ctx.creds.region,
        },
        {
          key: "masterUsername",
          label: "Master Username",
          kind: "text",
          required: true,
          defaultValue: "admin",
        },
        { key: "masterPassword", label: "Master Password", kind: "text", required: true },
      ],
    };
  }
  return null;
}

export async function databaseCreateResource(
  ctx: AwsCreateContext,
  typeId: string,
  accountId: string,
  fields: Record<string, string>,
  _parentResourceId?: string,
): Promise<ResourceInstance | null> {
  if (typeId === "dynamodb-table") {
    const region = fields["region"] ?? ctx.creds.region;
    const rctx = ctx.withRegion(region);
    const keySchema: Array<{ AttributeName: string; KeyType: string }> = [
      { AttributeName: fields["partitionKey"] ?? "id", KeyType: "HASH" },
    ];
    // Deduplicate attribute definitions by name — CreateTable rejects payloads
    // that declare the same attribute twice. We collect via map then flatten.
    const attrMap = new Map<string, string>();
    attrMap.set(fields["partitionKey"] ?? "id", fields["partitionKeyType"] ?? "S");
    if (fields["sortKey"]) {
      keySchema.push({ AttributeName: fields["sortKey"], KeyType: "RANGE" });
      attrMap.set(fields["sortKey"], fields["sortKeyType"] ?? "S");
    }

    const isProvisioned = fields["billingMode"] === "PROVISIONED";
    const parsedIndexes = parseSecondaryIndexesJson(fields["secondaryIndexesJson"] ?? "");
    const gsis = buildGsiPayloads(parsedIndexes.gsis, attrMap, isProvisioned);
    const lsis = buildLsiPayloads(parsedIndexes.lsis, attrMap, fields["partitionKey"] ?? "id");

    const body: Record<string, unknown> = {
      TableName: fields["tableName"] ?? "",
      KeySchema: keySchema,
      AttributeDefinitions: Array.from(attrMap, ([AttributeName, AttributeType]) => ({
        AttributeName,
        AttributeType,
      })),
      BillingMode: fields["billingMode"] ?? "PAY_PER_REQUEST",
      ...(gsis.length > 0 ? { GlobalSecondaryIndexes: gsis } : {}),
      ...(lsis.length > 0 ? { LocalSecondaryIndexes: lsis } : {}),
    };
    if (isProvisioned) {
      body["ProvisionedThroughput"] = {
        ReadCapacityUnits: 5,
        WriteCapacityUnits: 5,
      };
    }
    const data = await rctx.json<{ TableDescription: Record<string, unknown> }>(
      "dynamodb",
      "DynamoDB_20120810.CreateTable",
      body,
    );
    const t = data.TableDescription;
    const tableName = String(t["TableName"] ?? fields["tableName"] ?? "");
    return {
      id: ctx.makeId(accountId, "dynamodb-table", tableName),
      pluginId: "aws",
      resourceTypeId: "dynamodb-table",
      accountId,
      displayName: tableName,
      fields: {
        tableName,
        region,
        status: String(t["TableStatus"] ?? "CREATING"),
        itemCount: 0,
        sizeBytes: 0,
        billingMode: fields["billingMode"] ?? "PAY_PER_REQUEST",
        partitionKey: fields["partitionKey"] ?? "id",
        ...(fields["sortKey"] ? { sortKey: fields["sortKey"] } : {}),
      },
      resolvedOutputs: {
        tableArn: String(t["TableArn"] ?? ""),
      },
      secretStates: [],
      externalId: tableName,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }
  if (typeId === "rds-instance") {
    const region = fields["region"] ?? ctx.creds.region;
    const rctx = ctx.withRegion(region);
    const dbId = fields["dbInstanceId"] ?? "";
    const data = await rctx.queryPost<Record<string, unknown>>(
      "rds",
      "CreateDBInstance",
      "2014-10-31",
      {
        DBInstanceIdentifier: dbId,
        Engine: fields["engine"] ?? "postgres",
        DBInstanceClass: fields["instanceClass"] ?? "db.t3.micro",
        AllocatedStorage: String(fields["allocatedStorage"] ?? "20"),
        MasterUsername: fields["masterUsername"] ?? "admin",
        MasterUserPassword: fields["masterPassword"] ?? "",
      },
    );
    const createResult = data["CreateDBInstanceResult"] as Record<string, unknown> | undefined;
    const inst = (createResult?.["DBInstance"] as Record<string, unknown>) ?? {};
    return {
      id: ctx.makeId(accountId, "rds-instance", dbId),
      pluginId: "aws",
      resourceTypeId: "rds-instance",
      accountId,
      displayName: dbId,
      fields: {
        dbInstanceId: dbId,
        region,
        engine: fields["engine"] ?? "postgres",
        engineVersion: "",
        instanceClass: fields["instanceClass"] ?? "db.t3.micro",
        status: String(inst["DBInstanceStatus"] ?? "creating"),
        allocatedStorage: Number(fields["allocatedStorage"] ?? 20),
        availabilityZone: String(inst["AvailabilityZone"] ?? ""),
        multiAZ: false,
      },
      resolvedOutputs: {
        endpoint: "",
        port: "",
        masterUsername: fields["masterUsername"] ?? "admin",
      },
      secretStates: [],
      externalId: dbId,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }
  if (typeId === "elasticache-cluster") {
    const region = fields["region"] ?? ctx.creds.region;
    const rctx = ctx.withRegion(region);
    const clusterId = fields["cacheClusterId"] ?? "";
    await rctx.queryPost<Record<string, unknown>>(
      "elasticache",
      "CreateCacheCluster",
      "2015-02-02",
      {
        CacheClusterId: clusterId,
        Engine: fields["engine"] ?? "redis",
        CacheNodeType: fields["cacheNodeType"] ?? "cache.t3.micro",
        NumCacheNodes: String(fields["numCacheNodes"] ?? "1"),
      },
    );
    return {
      id: ctx.makeId(accountId, "elasticache-cluster", clusterId),
      pluginId: "aws",
      resourceTypeId: "elasticache-cluster",
      accountId,
      displayName: clusterId,
      fields: {
        clusterId,
        region,
        engine: fields["engine"] ?? "redis",
        engineVersion: "",
        nodeType: fields["cacheNodeType"] ?? "cache.t3.micro",
        numNodes: Number(fields["numCacheNodes"] ?? "1"),
        status: "creating",
        availabilityZone: "",
      },
      resolvedOutputs: {
        endpoint: "",
        port: "",
      },
      secretStates: [],
      externalId: clusterId,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }
  if (typeId === "rds-cluster") {
    const region = fields["region"] ?? ctx.creds.region;
    const rctx = ctx.withRegion(region);
    const clusterId = fields["dbClusterIdentifier"] ?? "";
    const data = await rctx.queryPost<Record<string, unknown>>(
      "rds",
      "CreateDBCluster",
      "2014-10-31",
      {
        DBClusterIdentifier: clusterId,
        Engine: fields["engine"] ?? "aurora-postgresql",
        MasterUsername: fields["masterUsername"] ?? "admin",
        MasterUserPassword: fields["masterPassword"] ?? "",
      },
    );
    const createResult = data["CreateDBClusterResult"] as Record<string, unknown> | undefined;
    const c = (createResult?.["DBCluster"] as Record<string, unknown>) ?? {};
    return {
      id: ctx.makeId(accountId, "rds-cluster", clusterId),
      pluginId: "aws",
      resourceTypeId: "rds-cluster",
      accountId,
      displayName: clusterId,
      fields: {
        clusterIdentifier: clusterId,
        region,
        engine: fields["engine"] ?? "aurora-postgresql",
        engineVersion: "",
        status: String(c["Status"] ?? "creating"),
        multiAZ: false,
        storageEncrypted: false,
        allocatedStorage: 0,
        dbClusterMembers: 0,
      },
      resolvedOutputs: {
        endpoint: String(c["Endpoint"] ?? ""),
        readerEndpoint: String(c["ReaderEndpoint"] ?? ""),
        port: String(c["Port"] ?? ""),
        masterUsername: fields["masterUsername"] ?? "admin",
        clusterArn: String(c["DBClusterArn"] ?? ""),
      },
      secretStates: [],
      externalId: clusterId,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }
  if (typeId === "redshift-cluster") {
    const region = fields["region"] ?? ctx.creds.region;
    const rctx = ctx.withRegion(region);
    const clusterId = fields["clusterIdentifier"] ?? "";
    const data = await rctx.json<{ Cluster?: Record<string, unknown> }>(
      "redshift",
      "RedshiftServiceVersion20121201.CreateCluster",
      {
        ClusterIdentifier: clusterId,
        NodeType: fields["nodeType"] ?? "dc2.large",
        MasterUsername: fields["masterUsername"] ?? "admin",
        MasterUserPassword: fields["masterPassword"] ?? "",
        NumberOfNodes: Number(fields["numberOfNodes"] ?? "1"),
        ...(Number(fields["numberOfNodes"] ?? "1") === 1
          ? { ClusterType: "single-node" }
          : { ClusterType: "multi-node" }),
      },
    );
    const c = data.Cluster ?? {};
    return {
      id: ctx.makeId(accountId, "redshift-cluster", clusterId),
      pluginId: "aws",
      resourceTypeId: "redshift-cluster",
      accountId,
      displayName: clusterId,
      fields: {
        clusterIdentifier: clusterId,
        region,
        nodeType: fields["nodeType"] ?? "dc2.large",
        status: String(c["ClusterStatus"] ?? "creating"),
        numberOfNodes: Number(fields["numberOfNodes"] ?? "1"),
        dbName: String(c["DBName"] ?? "dev"),
        availabilityZone: String(c["AvailabilityZone"] ?? ""),
        encrypted: false,
        publiclyAccessible: false,
      },
      resolvedOutputs: {
        endpoint: "",
        port: "",
        masterUsername: fields["masterUsername"] ?? "admin",
        clusterArn: `arn:aws:redshift:${region}:${accountId}:cluster:${clusterId}`,
      },
      secretStates: [],
      externalId: clusterId,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }
  if (typeId === "opensearch-domain") {
    const region = fields["region"] ?? ctx.creds.region;
    const rctx = ctx.withRegion(region);
    const domainName = fields["domainName"] ?? "";
    const host = rctx.hostForService("es");
    const url = `https://${host}/2021-01-01/opensearch/domain`;
    const bodyObj = {
      DomainName: domainName,
      EngineVersion: fields["engineVersion"] ?? "OpenSearch_3.5",
      ClusterConfig: {
        InstanceType: fields["instanceType"] ?? "t3.small.search",
        InstanceCount: Number(fields["instanceCount"] ?? "1"),
      },
      EBSOptions: {
        EBSEnabled: true,
        VolumeType: "gp3",
        VolumeSize: 10,
      },
    };
    const bodyStr = JSON.stringify(bodyObj);
    const res = await fetchSigned({
      method: "POST",
      url,
      headers: { Host: host, "Content-Type": "application/json" },
      body: bodyStr,
      service: "es",
      credentials: rctx.creds,
    });
    const result = (await res.json()) as Record<string, unknown>;
    const ds = (result["DomainStatus"] ?? {}) as Record<string, unknown>;
    return {
      id: ctx.makeId(accountId, "opensearch-domain", domainName),
      pluginId: "aws",
      resourceTypeId: "opensearch-domain",
      accountId,
      displayName: domainName,
      fields: {
        domainName,
        region,
        engineVersion: fields["engineVersion"] ?? "OpenSearch_3.5",
        instanceType: fields["instanceType"] ?? "t3.small.search",
        instanceCount: Number(fields["instanceCount"] ?? "1"),
        status: true,
        volumeType: "gp3",
        volumeSize: 10,
        encryptionEnabled: false,
      },
      resolvedOutputs: {
        endpoint: String(ds["Endpoint"] ?? ""),
        dashboardEndpoint: "",
        domainArn: String(ds["ARN"] ?? ""),
      },
      secretStates: [],
      externalId: domainName,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }
  if (typeId === "neptune-cluster") {
    const region = fields["region"] ?? ctx.creds.region;
    const rctx = ctx.withRegion(region);
    const clusterId = fields["dbClusterIdentifier"] ?? "";
    const data = await rctx.queryPost<Record<string, unknown>>(
      "rds",
      "CreateDBCluster",
      "2014-10-31",
      {
        DBClusterIdentifier: clusterId,
        Engine: "neptune",
      },
    );
    const createResult = data["CreateDBClusterResult"] as Record<string, unknown> | undefined;
    const c = (createResult?.["DBCluster"] as Record<string, unknown>) ?? {};
    return {
      id: ctx.makeId(accountId, "neptune-cluster", clusterId),
      pluginId: "aws",
      resourceTypeId: "neptune-cluster",
      accountId,
      displayName: clusterId,
      fields: {
        clusterIdentifier: clusterId,
        region,
        engine: "neptune",
        engineVersion: "",
        status: String(c["Status"] ?? "creating"),
        storageEncrypted: false,
        multiAZ: false,
        dbClusterMembers: 0,
      },
      resolvedOutputs: {
        endpoint: String(c["Endpoint"] ?? ""),
        readerEndpoint: String(c["ReaderEndpoint"] ?? ""),
        port: String(c["Port"] ?? "8182"),
        clusterArn: String(c["DBClusterArn"] ?? ""),
      },
      secretStates: [],
      externalId: clusterId,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }
  if (typeId === "documentdb-cluster") {
    const region = fields["region"] ?? ctx.creds.region;
    const rctx = ctx.withRegion(region);
    const clusterId = fields["dbClusterIdentifier"] ?? "";
    const data = await rctx.queryPost<Record<string, unknown>>(
      "rds",
      "CreateDBCluster",
      "2014-10-31",
      {
        DBClusterIdentifier: clusterId,
        Engine: "docdb",
        MasterUsername: fields["masterUsername"] ?? "admin",
        MasterUserPassword: fields["masterPassword"] ?? "",
      },
    );
    const createResult = data["CreateDBClusterResult"] as Record<string, unknown> | undefined;
    const c = (createResult?.["DBCluster"] as Record<string, unknown>) ?? {};
    return {
      id: ctx.makeId(accountId, "documentdb-cluster", clusterId),
      pluginId: "aws",
      resourceTypeId: "documentdb-cluster",
      accountId,
      displayName: clusterId,
      fields: {
        clusterIdentifier: clusterId,
        region,
        engine: "docdb",
        engineVersion: "",
        status: String(c["Status"] ?? "creating"),
        storageEncrypted: false,
        multiAZ: false,
        dbClusterMembers: 0,
      },
      resolvedOutputs: {
        endpoint: String(c["Endpoint"] ?? ""),
        readerEndpoint: String(c["ReaderEndpoint"] ?? ""),
        port: String(c["Port"] ?? "27017"),
        masterUsername: fields["masterUsername"] ?? "admin",
        clusterArn: String(c["DBClusterArn"] ?? ""),
      },
      secretStates: [],
      externalId: clusterId,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }
  return null;
}

/**
 * Shape the user supplies in `secondaryIndexesJson` on the DynamoDB create
 * form. Both arrays are optional; missing entries are treated as empty.
 */
interface SecondaryIndexInput {
  name?: string;
  partitionKey?: string;
  partitionKeyType?: string;
  sortKey?: string;
  sortKeyType?: string;
  projection?: string;
  /** Comma-separated or already-split list of non-key attributes for INCLUDE projection. */
  projectionInclude?: string[] | string;
}

interface ParsedSecondaryIndexes {
  gsis: SecondaryIndexInput[];
  lsis: SecondaryIndexInput[];
}

function parseSecondaryIndexesJson(raw: string): ParsedSecondaryIndexes {
  const trimmed = raw.trim();
  if (!trimmed) return { gsis: [], lsis: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (e) {
    throw new Error(
      `Secondary indexes JSON is not valid JSON: ${(e as Error).message}. Expected shape: { "gsis": [...], "lsis": [...] }`,
      { cause: e },
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error('Secondary indexes must be an object with "gsis" and/or "lsis" arrays.');
  }
  const obj = parsed as { gsis?: unknown; lsis?: unknown };
  const gsis = Array.isArray(obj.gsis) ? (obj.gsis as SecondaryIndexInput[]) : [];
  const lsis = Array.isArray(obj.lsis) ? (obj.lsis as SecondaryIndexInput[]) : [];
  return { gsis, lsis };
}

function buildProjection(input: SecondaryIndexInput, indexLabel: string): Record<string, unknown> {
  const type = (input.projection ?? "ALL").toUpperCase();
  if (type !== "ALL" && type !== "KEYS_ONLY" && type !== "INCLUDE") {
    throw new Error(`${indexLabel}: projection must be ALL, KEYS_ONLY, or INCLUDE.`);
  }
  const out: Record<string, unknown> = { ProjectionType: type };
  if (type === "INCLUDE") {
    const raw = input.projectionInclude;
    const cols = Array.isArray(raw)
      ? raw
      : typeof raw === "string"
        ? raw
            .split(",")
            .map((c) => c.trim())
            .filter((c) => c.length > 0)
        : [];
    if (cols.length === 0) {
      throw new Error(`${indexLabel}: INCLUDE projection needs projectionInclude attributes.`);
    }
    out["NonKeyAttributes"] = cols;
  }
  return out;
}

function buildGsiPayloads(
  inputs: SecondaryIndexInput[],
  attrMap: Map<string, string>,
  isProvisioned: boolean,
): Array<Record<string, unknown>> {
  return inputs.map((g, i) => {
    const label = `GSI #${i + 1}`;
    const name = (g.name ?? "").trim();
    const pk = (g.partitionKey ?? "").trim();
    if (!name) throw new Error(`${label}: missing "name".`);
    if (!pk) throw new Error(`${label} (${name}): missing "partitionKey".`);
    attrMap.set(pk, (g.partitionKeyType ?? "S").toUpperCase());
    const KeySchema: Array<{ AttributeName: string; KeyType: string }> = [
      { AttributeName: pk, KeyType: "HASH" },
    ];
    const sk = (g.sortKey ?? "").trim();
    if (sk) {
      attrMap.set(sk, (g.sortKeyType ?? "S").toUpperCase());
      KeySchema.push({ AttributeName: sk, KeyType: "RANGE" });
    }
    const payload: Record<string, unknown> = {
      IndexName: name,
      KeySchema,
      Projection: buildProjection(g, `${label} (${name})`),
    };
    // Provisioned tables require per-GSI throughput; on-demand tables inherit
    // the table's billing mode and reject ProvisionedThroughput on indexes.
    if (isProvisioned) {
      payload["ProvisionedThroughput"] = { ReadCapacityUnits: 5, WriteCapacityUnits: 5 };
    }
    return payload;
  });
}

function buildLsiPayloads(
  inputs: SecondaryIndexInput[],
  attrMap: Map<string, string>,
  tablePartitionKey: string,
): Array<Record<string, unknown>> {
  return inputs.map((l, i) => {
    const label = `LSI #${i + 1}`;
    const name = (l.name ?? "").trim();
    const sk = (l.sortKey ?? "").trim();
    if (!name) throw new Error(`${label}: missing "name".`);
    if (!sk) throw new Error(`${label} (${name}): missing "sortKey".`);
    attrMap.set(sk, (l.sortKeyType ?? "S").toUpperCase());
    // LSIs share the table's partition key — DynamoDB requires it to appear
    // as the HASH attribute in the LSI's KeySchema.
    return {
      IndexName: name,
      KeySchema: [
        { AttributeName: tablePartitionKey, KeyType: "HASH" },
        { AttributeName: sk, KeyType: "RANGE" },
      ],
      Projection: buildProjection(l, `${label} (${name})`),
    };
  });
}
