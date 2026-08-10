import type { ResourceInstance } from "@infrawrench/plugin-base";
import { ensureArray } from "../xml.js";
import { joinIds, rdsSecurityGroupIds, type ListerContext } from "../resource-listers.js";

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
    // Redshift wraps its VPC groups in `VpcSecurityGroup` members (the RDS
    // family uses `VpcSecurityGroupMembership` for the same shape).
    const vpcSecurityGroups = ensureArray(
      (c["VpcSecurityGroups"] as Record<string, unknown> | undefined)?.["VpcSecurityGroup"],
    ) as Record<string, unknown>[];
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
        vpcId: String(c["VpcId"] ?? ""),
        securityGroupIds: joinIds(vpcSecurityGroups.map((g) => g["VpcSecurityGroupId"])),
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
    const members = ensureArray(membersContainer?.["DBClusterMember"]) as Record<string, unknown>[];
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
        // The count stays; these are the member instances themselves.
        dbClusterMemberIds: joinIds(members.map((m) => m["DBInstanceIdentifier"])),
        securityGroupIds: rdsSecurityGroupIds(c),
        // Cluster describes report only the subnet group's *name* (instance
        // describes inline the whole group). The db-subnet-group resource
        // resolves it to the vpc and subnets it stands for.
        dbSubnetGroupName: String(c["DBSubnetGroup"] ?? ""),
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
      // Only present on VPC-attached domains; public domains leave it unset.
      const vpcOptions = ds["VPCOptions"] as Record<string, unknown> | undefined;

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
          vpcId: String(vpcOptions?.["VPCId"] ?? ""),
          subnetIds: joinIds((vpcOptions?.["SubnetIds"] as string[] | undefined) ?? []),
          securityGroupIds: joinIds(
            (vpcOptions?.["SecurityGroupIds"] as string[] | undefined) ?? [],
          ),
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
  // The "neptune" service key is routed to rds.<region>.amazonaws.com by the
  // transport layer (see client-transport.ts resolveEndpoint): the SDK's
  // neptune.<region> endpoint template does not resolve in DNS. Neptune
  // shares the DescribeDBClusters action (and control plane) with RDS, so
  // the RDS host is the one that actually works — do not "fix" this back to
  // a neptune.* host.
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
      const members = ensureArray(membersContainer?.["DBClusterMember"]) as Record<
        string,
        unknown
      >[];
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
          // The count stays; these are the member instances themselves, which
          // DescribeDBInstances also lists as rds-instance resources.
          dbClusterMemberIds: joinIds(members.map((m) => m["DBInstanceIdentifier"])),
          securityGroupIds: rdsSecurityGroupIds(c),
          // Cluster describes report only the subnet group's *name* (instance
          // describes inline the whole group). The db-subnet-group resource
          // resolves it to the vpc and subnets it stands for.
          dbSubnetGroupName: String(c["DBSubnetGroup"] ?? ""),
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
      const members = ensureArray(membersContainer?.["DBClusterMember"]) as Record<
        string,
        unknown
      >[];
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
          // The count stays; these are the member instances themselves, which
          // DescribeDBInstances also lists as rds-instance resources.
          dbClusterMemberIds: joinIds(members.map((m) => m["DBInstanceIdentifier"])),
          securityGroupIds: rdsSecurityGroupIds(c),
          // Cluster describes report only the subnet group's *name* (instance
          // describes inline the whole group). The db-subnet-group resource
          // resolves it to the vpc and subnets it stands for.
          dbSubnetGroupName: String(c["DBSubnetGroup"] ?? ""),
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

/**
 * RDS DB subnet groups.
 *
 * The RDS-family cluster APIs (`DescribeDBClusters`, and the DocumentDB /
 * Neptune variants of it) report a cluster's network placement as nothing but
 * the subnet group's *name* — unlike `DescribeDBInstances`, which inlines the
 * whole group. Listing the groups as their own resource turns that bare name
 * into a real edge, and gives clusters the `→ vpc` / `→ subnet` reach they
 * otherwise have no route to.
 *
 * `externalId` is the group name so the `DBSubnetGroupName` values already
 * stored on the clusters match without any translation.
 */
export async function listDBSubnetGroups(
  ctx: ListerContext,
  accountId: string,
): Promise<ResourceInstance[]> {
  const data = await ctx.ec2Query<Record<string, unknown>>(
    "rds",
    "DescribeDBSubnetGroups",
    "2014-10-31",
  );
  const result = data["DescribeDBSubnetGroupsResult"] as Record<string, unknown> | undefined;
  const groups = ensureArray(
    (result?.["DBSubnetGroups"] as Record<string, unknown> | undefined)?.["DBSubnetGroup"],
  ) as Record<string, unknown>[];

  return groups.map((g) => {
    const name = String(g["DBSubnetGroupName"] ?? "");
    const subnets = ensureArray(
      (g["Subnets"] as Record<string, unknown> | undefined)?.["Subnet"],
    ) as Record<string, unknown>[];
    return {
      id: ctx.id(accountId, "db-subnet-group", name),
      pluginId: "aws",
      resourceTypeId: "db-subnet-group",
      accountId,
      displayName: name,
      fields: {
        name,
        region: ctx.region,
        vpcId: String(g["VpcId"] ?? ""),
        subnetIds: joinIds(subnets.map((s) => s["SubnetIdentifier"])),
        status: String(g["SubnetGroupStatus"] ?? ""),
        description: String(g["DBSubnetGroupDescription"] ?? ""),
      },
      resolvedOutputs: {
        subnetGroupArn: String(g["DBSubnetGroupArn"] ?? ""),
      },
      secretStates: [],
      externalId: name,
      createdAt: ctx.now(),
      updatedAt: ctx.now(),
    };
  });
}
