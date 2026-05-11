import type { CreateResourceConfig, ResourceInstance } from "@infrawrench/plugin-base";
import { signRequest } from "../auth.js";
import type { AwsCreateContext } from "./shared.js";

export async function databaseGetCreateConfig(
  _ctx: AwsCreateContext,
  typeId: string,
  _parentResourceId?: string,
): Promise<CreateResourceConfig | null> {
  if (typeId === "dynamodb-table") {
    return {
      fields: [
        { key: "tableName", label: "Table Name", kind: "text", required: true },
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
      ],
    };
  }
  if (typeId === "rds-instance") {
    return {
      fields: [
        { key: "dbInstanceId", label: "DB Instance Identifier", kind: "text", required: true },
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
          key: "engineVersion",
          label: "Engine Version",
          kind: "text",
          required: true,
          defaultValue: "OpenSearch_2.11",
          description: "e.g. OpenSearch_2.11 or Elasticsearch_7.10",
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
      ],
    };
  }
  if (typeId === "documentdb-cluster") {
    return {
      fields: [
        { key: "dbClusterIdentifier", label: "Cluster Identifier", kind: "text", required: true },
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
    const keySchema: Array<{ AttributeName: string; KeyType: string }> = [
      { AttributeName: fields["partitionKey"] ?? "id", KeyType: "HASH" },
    ];
    const attrDefs: Array<{ AttributeName: string; AttributeType: string }> = [
      {
        AttributeName: fields["partitionKey"] ?? "id",
        AttributeType: fields["partitionKeyType"] ?? "S",
      },
    ];
    if (fields["sortKey"]) {
      keySchema.push({ AttributeName: fields["sortKey"], KeyType: "RANGE" });
      attrDefs.push({
        AttributeName: fields["sortKey"],
        AttributeType: fields["sortKeyType"] ?? "S",
      });
    }
    const body: Record<string, unknown> = {
      TableName: fields["tableName"] ?? "",
      KeySchema: keySchema,
      AttributeDefinitions: attrDefs,
      BillingMode: fields["billingMode"] ?? "PAY_PER_REQUEST",
    };
    if (fields["billingMode"] === "PROVISIONED") {
      body["ProvisionedThroughput"] = {
        ReadCapacityUnits: 5,
        WriteCapacityUnits: 5,
      };
    }
    const data = await ctx.json<{ TableDescription: Record<string, unknown> }>(
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
    const dbId = fields["dbInstanceId"] ?? "";
    const data = await ctx.queryPost<Record<string, unknown>>(
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
    const clusterId = fields["cacheClusterId"] ?? "";
    await ctx.queryPost<Record<string, unknown>>(
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
    const clusterId = fields["dbClusterIdentifier"] ?? "";
    const data = await ctx.queryPost<Record<string, unknown>>(
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
    const clusterId = fields["clusterIdentifier"] ?? "";
    const data = await ctx.json<{ Cluster?: Record<string, unknown> }>(
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
        clusterArn: `arn:aws:redshift:${ctx.creds.region}:${accountId}:cluster:${clusterId}`,
      },
      secretStates: [],
      externalId: clusterId,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }
  if (typeId === "opensearch-domain") {
    const domainName = fields["domainName"] ?? "";
    const host = ctx.hostForService("es");
    const url = `https://${host}/2021-01-01/opensearch/domain`;
    const bodyObj = {
      DomainName: domainName,
      EngineVersion: fields["engineVersion"] ?? "OpenSearch_2.11",
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
    const headers = await signRequest({
      method: "POST",
      url,
      headers: { Host: host, "Content-Type": "application/json" },
      body: bodyStr,
      service: "es",
      credentials: ctx.creds,
    });
    const res = await fetch(url, { method: "POST", headers, body: bodyStr });
    if (!res.ok)
      throw new Error(`OpenSearch CreateDomain failed: ${res.status} ${await res.text()}`);
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
        engineVersion: fields["engineVersion"] ?? "OpenSearch_2.11",
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
    const clusterId = fields["dbClusterIdentifier"] ?? "";
    const data = await ctx.queryPost<Record<string, unknown>>(
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
    const clusterId = fields["dbClusterIdentifier"] ?? "";
    const data = await ctx.queryPost<Record<string, unknown>>(
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
