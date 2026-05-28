import type { ResourceInstance } from "@infrawrench/plugin-base";
import { ensureArray } from "../auth.js";
import type { ListerContext } from "../resource-listers.js";

export async function listRedshiftClusters(
  ctx: ListerContext,
  accountId: string,
): Promise<ResourceInstance[]> {
  const data = await ctx.ec2Query<Record<string, unknown>>(
    "redshift",
    "DescribeClusters",
    "2012-12-01",
  );
  const clusters = ensureArray(
    (data["Clusters"] as Record<string, unknown> | undefined)?.["member"],
  ) as Record<string, unknown>[];

  return clusters.map((c) => {
    const clusterId = String(c["ClusterIdentifier"] ?? "");
    const endpoint = c["Endpoint"] as Record<string, unknown> | undefined;
    return {
      id: ctx.id(accountId, "redshift-cluster", clusterId),
      pluginId: "aws",
      resourceTypeId: "redshift-cluster",
      accountId,
      displayName: clusterId,
      fields: {
        clusterIdentifier: clusterId,
        region: ctx.region,
        nodeType: String(c["NodeType"] ?? ""),
        status: String(c["ClusterStatus"] ?? ""),
        numberOfNodes: Number(c["NumberOfNodes"] ?? 0),
        dbName: String(c["DBName"] ?? ""),
        availabilityZone: String(c["AvailabilityZone"] ?? ""),
        encrypted: c["Encrypted"] === true || c["Encrypted"] === "true",
        publiclyAccessible: c["PubliclyAccessible"] === true || c["PubliclyAccessible"] === "true",
      },
      resolvedOutputs: {
        endpoint: String(endpoint?.["Address"] ?? ""),
        port: String(endpoint?.["Port"] ?? ""),
        masterUsername: String(c["MasterUsername"] ?? ""),
        clusterArn: `arn:aws:redshift:${ctx.region}:${accountId}:cluster:${clusterId}`,
        connectionString: endpoint?.["Address"]
          ? `postgresql://${String(c["MasterUsername"] ?? "")}@${String(endpoint["Address"])}:${String(endpoint["Port"] ?? 5439)}/${String(c["DBName"] ?? "dev")}`
          : "",
      },
      secretStates: [],
      externalId: clusterId,
      createdAt: String(c["ClusterCreateTime"] ?? ctx.now()),
      updatedAt: ctx.now(),
    };
  });
}

export async function listRDSClusters(
  ctx: ListerContext,
  accountId: string,
): Promise<ResourceInstance[]> {
  const data = await ctx.ec2Query<Record<string, unknown>>(
    "rds",
    "DescribeDBClusters",
    "2014-10-31",
  );
  const result = data["DescribeDBClustersResult"] as Record<string, unknown> | undefined;
  const clusters = ensureArray(
    (result?.["DBClusters"] as Record<string, unknown> | undefined)?.["DBCluster"],
  ) as Record<string, unknown>[];
  return clusters.map((c) => {
    const clusterId = String(c["DBClusterIdentifier"] ?? "");
    const membersContainer = c["DBClusterMembers"] as Record<string, unknown> | undefined;
    const members = ensureArray(membersContainer?.["DBClusterMember"]);
    return {
      id: ctx.id(accountId, "rds-cluster", clusterId),
      pluginId: "aws",
      resourceTypeId: "rds-cluster",
      accountId,
      displayName: clusterId,
      fields: {
        clusterIdentifier: clusterId,
        region: ctx.region,
        engine: String(c["Engine"] ?? ""),
        engineVersion: String(c["EngineVersion"] ?? ""),
        status: String(c["Status"] ?? ""),
        multiAZ: String(c["MultiAZ"]) === "true",
        storageEncrypted: String(c["StorageEncrypted"]) === "true",
        allocatedStorage: Number(c["AllocatedStorage"] ?? 0),
        dbClusterMembers: members.length,
      },
      resolvedOutputs: {
        endpoint: String(c["Endpoint"] ?? ""),
        readerEndpoint: String(c["ReaderEndpoint"] ?? ""),
        port: String(c["Port"] ?? ""),
        masterUsername: String(c["MasterUsername"] ?? ""),
        clusterArn: String(c["DBClusterArn"] ?? ""),
        connectionString: c["Endpoint"]
          ? `${String(c["Engine"] ?? "").startsWith("aurora-postgresql") ? "postgresql" : "mysql"}://${String(c["MasterUsername"] ?? "")}@${String(c["Endpoint"])}:${String(c["Port"] ?? "")}`
          : "",
      },
      secretStates: [],
      externalId: clusterId,
      createdAt: String(c["ClusterCreateTime"] ?? ctx.now()),
      updatedAt: ctx.now(),
    };
  });
}

export async function listOpenSearchDomains(
  ctx: ListerContext,
  accountId: string,
): Promise<ResourceInstance[]> {
  const listData = await ctx.jsonGet<{
    DomainNames?: Array<{ DomainName: string }>;
  }>("es", "/2021-01-01/domain");
  const domainNames = listData.DomainNames ?? [];
  const results: ResourceInstance[] = [];

  for (const d of domainNames) {
    const domainName = d.DomainName;
    try {
      const detail = await ctx.jsonGet<{
        DomainStatus: Record<string, unknown>;
      }>("es", `/2021-01-01/opensearch/domain/${encodeURIComponent(domainName)}`);
      const ds = detail.DomainStatus;
      const clusterConfig = ds["ClusterConfig"] as Record<string, unknown> | undefined;
      const ebsOptions = ds["EBSOptions"] as Record<string, unknown> | undefined;
      const encryptionConfig = ds["EncryptionAtRestOptions"] as Record<string, unknown> | undefined;

      results.push({
        id: ctx.id(accountId, "opensearch-domain", domainName),
        pluginId: "aws",
        resourceTypeId: "opensearch-domain",
        accountId,
        displayName: domainName,
        fields: {
          domainName,
          region: ctx.region,
          engineVersion: String(ds["EngineVersion"] ?? ""),
          instanceType: String(clusterConfig?.["InstanceType"] ?? ""),
          instanceCount: Number(clusterConfig?.["InstanceCount"] ?? 0),
          status: ds["Processing"] === true,
          volumeType: String(ebsOptions?.["VolumeType"] ?? ""),
          volumeSize: Number(ebsOptions?.["VolumeSize"] ?? 0),
          encryptionEnabled: encryptionConfig?.["Enabled"] === true,
        },
        resolvedOutputs: {
          endpoint: String(ds["Endpoint"] ?? ds["Endpoints"]?.toString() ?? ""),
          dashboardEndpoint: ds["Endpoint"] ? `${ds["Endpoint"]}/_dashboards` : "",
          domainArn: String(ds["ARN"] ?? ""),
        },
        secretStates: [],
        externalId: domainName,
        createdAt: ctx.now(),
        updatedAt: ctx.now(),
      });
    } catch {
      // Skip domains we can't describe
    }
  }
  return results;
}

export async function listNeptuneClusters(
  ctx: ListerContext,
  accountId: string,
): Promise<ResourceInstance[]> {
  // Talk to neptune.<region>.amazonaws.com — NOT rds.<region>. Neptune
  // shares the DescribeDBClusters action with RDS but has its own
  // endpoint; the previous SERVICE_HOSTS aliasing was a known bug.
  const data = await ctx.ec2Query<Record<string, unknown>>(
    "neptune",
    "DescribeDBClusters",
    "2014-10-31",
    {
      "Filters.Filter.1.Name": "engine",
      "Filters.Filter.1.Values.Value.1": "neptune",
    },
  );
  const result = data["DescribeDBClustersResult"] as Record<string, unknown> | undefined;
  const clusters = ensureArray(
    (result?.["DBClusters"] as Record<string, unknown> | undefined)?.["DBCluster"],
  ) as Record<string, unknown>[];
  return clusters
    .filter((c) => String(c["Engine"] ?? "") === "neptune")
    .map((c) => {
      const clusterId = String(c["DBClusterIdentifier"] ?? "");
      const membersContainer = c["DBClusterMembers"] as Record<string, unknown> | undefined;
      const members = ensureArray(membersContainer?.["DBClusterMember"]);
      return {
        id: ctx.id(accountId, "neptune-cluster", clusterId),
        pluginId: "aws",
        resourceTypeId: "neptune-cluster",
        accountId,
        displayName: clusterId,
        fields: {
          clusterIdentifier: clusterId,
          region: ctx.region,
          engine: String(c["Engine"] ?? ""),
          engineVersion: String(c["EngineVersion"] ?? ""),
          status: String(c["Status"] ?? ""),
          storageEncrypted: String(c["StorageEncrypted"]) === "true",
          multiAZ: String(c["MultiAZ"]) === "true",
          dbClusterMembers: members.length,
        },
        resolvedOutputs: {
          endpoint: String(c["Endpoint"] ?? ""),
          readerEndpoint: String(c["ReaderEndpoint"] ?? ""),
          port: String(c["Port"] ?? ""),
          clusterArn: String(c["DBClusterArn"] ?? ""),
        },
        secretStates: [],
        externalId: clusterId,
        createdAt: String(c["ClusterCreateTime"] ?? ctx.now()),
        updatedAt: ctx.now(),
      };
    });
}

export async function listDocumentDBClusters(
  ctx: ListerContext,
  accountId: string,
): Promise<ResourceInstance[]> {
  const data = await ctx.ec2Query<Record<string, unknown>>(
    "rds",
    "DescribeDBClusters",
    "2014-10-31",
    {
      "Filters.Filter.1.Name": "engine",
      "Filters.Filter.1.Values.Value.1": "docdb",
    },
  );
  const result = data["DescribeDBClustersResult"] as Record<string, unknown> | undefined;
  const clusters = ensureArray(
    (result?.["DBClusters"] as Record<string, unknown> | undefined)?.["DBCluster"],
  ) as Record<string, unknown>[];
  return clusters
    .filter((c) => String(c["Engine"] ?? "") === "docdb")
    .map((c) => {
      const clusterId = String(c["DBClusterIdentifier"] ?? "");
      const membersContainer = c["DBClusterMembers"] as Record<string, unknown> | undefined;
      const members = ensureArray(membersContainer?.["DBClusterMember"]);
      return {
        id: ctx.id(accountId, "documentdb-cluster", clusterId),
        pluginId: "aws",
        resourceTypeId: "documentdb-cluster",
        accountId,
        displayName: clusterId,
        fields: {
          clusterIdentifier: clusterId,
          region: ctx.region,
          engine: String(c["Engine"] ?? ""),
          engineVersion: String(c["EngineVersion"] ?? ""),
          status: String(c["Status"] ?? ""),
          storageEncrypted: String(c["StorageEncrypted"]) === "true",
          multiAZ: String(c["MultiAZ"]) === "true",
          dbClusterMembers: members.length,
        },
        resolvedOutputs: {
          endpoint: String(c["Endpoint"] ?? ""),
          readerEndpoint: String(c["ReaderEndpoint"] ?? ""),
          port: String(c["Port"] ?? ""),
          masterUsername: String(c["MasterUsername"] ?? ""),
          clusterArn: String(c["DBClusterArn"] ?? ""),
          connectionString: c["Endpoint"]
            ? `mongodb://${String(c["MasterUsername"] ?? "")}@${String(c["Endpoint"])}:${String(c["Port"] ?? 27017)}/`
            : "",
        },
        secretStates: [],
        externalId: clusterId,
        createdAt: String(c["ClusterCreateTime"] ?? ctx.now()),
        updatedAt: ctx.now(),
      };
    });
}

export async function listEFSFileSystems(
  ctx: ListerContext,
  accountId: string,
): Promise<ResourceInstance[]> {
  const data = await ctx.jsonGet<{
    FileSystems?: Record<string, unknown>[];
  }>("elasticfilesystem", "/2015-02-01/file-systems");
  const fileSystems = data.FileSystems ?? [];

  return fileSystems.map((fs) => {
    const fsId = String(fs["FileSystemId"] ?? "");
    const tagSet = fs["Tags"] as Array<Record<string, string>> | undefined;
    const nameTag = tagSet?.find((t) => t["Key"] === "Name");
    const name = nameTag ? (nameTag["Value"] ?? "") : "";
    const sizeObj = fs["SizeInBytes"] as Record<string, unknown> | undefined;

    return {
      id: ctx.id(accountId, "efs-file-system", fsId),
      pluginId: "aws",
      resourceTypeId: "efs-file-system",
      accountId,
      displayName: name || fsId,
      fields: {
        name,
        fileSystemId: fsId,
        region: ctx.region,
        lifeCycleState: String(fs["LifeCycleState"] ?? ""),
        performanceMode: String(fs["PerformanceMode"] ?? ""),
        throughputMode: String(fs["ThroughputMode"] ?? ""),
        sizeInBytes: Number(sizeObj?.["Value"] ?? 0),
        encrypted: fs["Encrypted"] === true,
        numberOfMountTargets: Number(fs["NumberOfMountTargets"] ?? 0),
      },
      resolvedOutputs: {
        fileSystemArn: String(fs["FileSystemArn"] ?? ""),
        fileSystemId: fsId,
      },
      secretStates: [],
      externalId: fsId,
      createdAt: String(fs["CreationTime"] ?? ctx.now()),
      updatedAt: ctx.now(),
    };
  });
}
