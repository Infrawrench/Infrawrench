import type { ResourceInstance } from "@infrawrench/plugin-base";
import { Sha256 } from "@aws-crypto/sha256-js";
import { HttpRequest } from "@smithy/protocol-http";
import { SignatureV4 } from "@smithy/signature-v4";
import { ensureArray, type AwsCredentials } from "./auth.js";
import { ec2SshUsernameFromImageName } from "./ssh-username.js";

export interface ListerContext {
  ec2<T>(action: string, params?: Record<string, string>): Promise<T>;
  json<T>(service: string, target: string, body: Record<string, unknown>): Promise<T>;
  jsonGet<T>(service: string, path: string): Promise<T>;
  /** REST-JSON POST/GET with a path (Batch /v1/*, MQ /v1/*, …). */
  restJson<T>(
    service: string,
    path: string,
    body?: Record<string, unknown>,
    method?: "POST" | "GET",
  ): Promise<T>;
  /** Make an XML Query API call for non-EC2 services (ELBv2, AutoScaling, Redshift, CloudFormation, RDS, IAM, etc.) */
  ec2Query<T>(
    service: string,
    action: string,
    version: string,
    params?: Record<string, string>,
  ): Promise<T>;
  /** Make a signed XML GET request to a service path (e.g. S3 ListBuckets) */
  xmlGet<T>(service: string, path?: string): Promise<T>;
  id(accountId: string, typeId: string, externalId: string): string;
  now(): string;
  region: string;
  /**
   * AWS credentials for this account. Used by EKS kubeconfig generation to
   * embed an `env:` block in the exec credential plugin so the spawned `aws`
   * CLI uses Infrawrench's creds instead of whatever the host machine's
   * AWS_PROFILE / `~/.aws/config` points at (which often includes an
   * assume-role the user isn't authorized for).
   */
  creds: AwsCredentials;
}

export async function listEC2Instances(
  ctx: ListerContext,
  accountId: string,
): Promise<ResourceInstance[]> {
  const data = await ctx.ec2<Record<string, unknown>>("DescribeInstances");
  const reservations = ensureArray(
    (data["reservationSet"] as Record<string, unknown> | undefined)?.["item"],
  ) as Record<string, unknown>[];

  // Batch-resolve AMI names so we can derive SSH usernames from vendor
  // conventions. One DescribeImages call covers all distinct AMI IDs across
  // the reservations rather than per-instance.
  const imageIds = new Set<string>();
  for (const reservation of reservations) {
    const instances = ensureArray(
      (reservation["instancesSet"] as Record<string, unknown> | undefined)?.["item"],
    ) as Record<string, unknown>[];
    for (const inst of instances) {
      const imageId = String(inst["imageId"] ?? "");
      if (imageId) imageIds.add(imageId);
    }
  }
  const amiNameByImageId = new Map<string, string>();
  if (imageIds.size > 0) {
    try {
      const params: Record<string, string> = {};
      let i = 1;
      for (const id of imageIds) {
        params[`ImageId.${i}`] = id;
        i++;
      }
      const imagesData = await ctx.ec2<Record<string, unknown>>("DescribeImages", params);
      const imagesSet = imagesData["imagesSet"] as Record<string, unknown> | undefined;
      for (const img of ensureArray(imagesSet?.["item"]) as Record<string, unknown>[]) {
        const id = String(img["imageId"] ?? "");
        const name = String(img["name"] ?? img["description"] ?? "");
        if (id) amiNameByImageId.set(id, name);
      }
    } catch {
      // DescribeImages permission missing or rate-limited — proceed without
      // username resolution. The empty fallback path is harmless.
    }
  }

  // Cross-reference security groups so we can flag whether SSH (TCP/22) is
  // reachable per the SG rules. The #1 cause of "ssh times out" is a missing
  // inbound rule on port 22, so surfacing this on the instance directly
  // saves the user from clicking through to each SG to find out.
  const sshCidrsByGroupId = new Map<string, string[]>();
  try {
    const sgData = await ctx.ec2<Record<string, unknown>>("DescribeSecurityGroups");
    const sgs = ensureArray(
      (sgData["securityGroupInfo"] as Record<string, unknown> | undefined)?.["item"],
    ) as Record<string, unknown>[];
    for (const sg of sgs) {
      const gid = String(sg["groupId"] ?? "");
      if (!gid) continue;
      const rules = ensureArray(
        (sg["ipPermissions"] as Record<string, unknown> | undefined)?.["item"],
      ) as Record<string, unknown>[];
      const cidrs: string[] = [];
      for (const rule of rules) {
        const proto = String(rule["ipProtocol"] ?? "");
        const fromPort = Number(rule["fromPort"] ?? -1);
        const toPort = Number(rule["toPort"] ?? -1);
        // `-1` means "all protocols / all ports" (AWS encodes this in
        // ipProtocol="-1"). Otherwise check the port range covers 22.
        const allPorts = proto === "-1";
        const tcp22 = proto === "tcp" && fromPort <= 22 && toPort >= 22;
        if (!allPorts && !tcp22) continue;
        const ranges = ensureArray(
          (rule["ipRanges"] as Record<string, unknown> | undefined)?.["item"],
        ) as Record<string, unknown>[];
        for (const r of ranges) {
          const cidr = String(r["cidrIp"] ?? "");
          if (cidr) cidrs.push(cidr);
        }
        // IPv6 — same shape under a different key.
        const ranges6 = ensureArray(
          (rule["ipv6Ranges"] as Record<string, unknown> | undefined)?.["item"],
        ) as Record<string, unknown>[];
        for (const r of ranges6) {
          const cidr = String(r["cidrIpv6"] ?? "");
          if (cidr) cidrs.push(cidr);
        }
      }
      sshCidrsByGroupId.set(gid, cidrs);
    }
  } catch {
    // SG describe failed (permission, throttle, …); SSH summary just won't
    // include the rule context.
  }

  const results: ResourceInstance[] = [];
  for (const reservation of reservations) {
    const instances = ensureArray(
      (reservation["instancesSet"] as Record<string, unknown> | undefined)?.["item"],
    ) as Record<string, unknown>[];

    for (const inst of instances) {
      const instanceId = String(inst["instanceId"] ?? "");
      const state = String(
        (inst["instanceState"] as Record<string, unknown> | undefined)?.["name"] ?? "",
      );

      // Extract Name tag
      const tagSet = inst["tagSet"] as Record<string, unknown> | undefined;
      const tags = ensureArray(tagSet?.["item"]) as Record<string, unknown>[];
      const nameTag = tags.find((t) => t["key"] === "Name");
      const name = nameTag ? String(nameTag["value"] ?? "") : "";

      // Network info
      const publicIp = String(inst["ipAddress"] ?? "");
      const privateIp = String(inst["privateIpAddress"] ?? "");
      const publicDns = String(inst["dnsName"] ?? "");

      // Security group membership comes back on the instance under
      // groupSet.item[].groupId (different from `securityGroups` which only
      // appears on EC2-Classic instances).
      const groupSet = inst["groupSet"] as Record<string, unknown> | undefined;
      const sgIds = (ensureArray(groupSet?.["item"]) as Record<string, unknown>[])
        .map((g) => String(g["groupId"] ?? ""))
        .filter((id) => id.length > 0);

      const sshCidrs = new Set<string>();
      for (const sgId of sgIds) {
        for (const cidr of sshCidrsByGroupId.get(sgId) ?? []) sshCidrs.add(cidr);
      }
      let sshAccess: string;
      if (sshCidrs.size === 0) {
        sshAccess =
          "⚠ Port 22 not exposed by any attached security group — SSH will time out. Add an inbound rule for TCP/22.";
      } else if (sshCidrs.has("0.0.0.0/0") || sshCidrs.has("::/0")) {
        sshAccess = "Port 22 open to the world (0.0.0.0/0).";
      } else {
        const list = [...sshCidrs].slice(0, 4).join(", ");
        sshAccess = `Port 22 open from ${list}${sshCidrs.size > 4 ? ` (+${sshCidrs.size - 4} more)` : ""}.`;
      }

      results.push({
        id: ctx.id(accountId, "ec2-instance", instanceId),
        pluginId: "aws",
        resourceTypeId: "ec2-instance",
        accountId,
        displayName: name || instanceId,
        fields: {
          name,
          instanceId,
          region: ctx.region,
          instanceType: String(inst["instanceType"] ?? ""),
          availabilityZone: String(
            (inst["placement"] as Record<string, unknown> | undefined)?.["availabilityZone"] ?? "",
          ),
          state,
          imageId: String(inst["imageId"] ?? ""),
          vpcId: String(inst["vpcId"] ?? ""),
          subnetId: String(inst["subnetId"] ?? ""),
          securityGroupIds: sgIds.join(", "),
          sshAccess,
          sshUsername: ec2SshUsernameFromImageName(
            amiNameByImageId.get(String(inst["imageId"] ?? "")) ?? "",
          ),
        },
        resolvedOutputs: { publicIp, privateIp, publicDns },
        secretStates: [],
        externalId: instanceId,
        createdAt: String(inst["launchTime"] ?? ctx.now()),
        updatedAt: ctx.now(),
      });
    }
  }
  return results;
}

export async function listEBSVolumes(
  ctx: ListerContext,
  accountId: string,
): Promise<ResourceInstance[]> {
  const data = await ctx.ec2<Record<string, unknown>>("DescribeVolumes");
  const volumes = ensureArray(
    (data["volumeSet"] as Record<string, unknown> | undefined)?.["item"],
  ) as Record<string, unknown>[];

  return volumes.map((vol) => {
    const volumeId = String(vol["volumeId"] ?? "");
    const attachments = ensureArray(
      (vol["attachmentSet"] as Record<string, unknown> | undefined)?.["item"],
    ) as Record<string, unknown>[];
    const attachedTo = attachments[0] ? String(attachments[0]["instanceId"] ?? "") : "";

    // Extract Name tag
    const tagSet = vol["tagSet"] as Record<string, unknown> | undefined;
    const tags = ensureArray(tagSet?.["item"]) as Record<string, unknown>[];
    const nameTag = tags.find((t) => t["key"] === "Name");
    const name = nameTag ? String(nameTag["value"] ?? "") : "";

    return {
      id: ctx.id(accountId, "ebs-volume", volumeId),
      pluginId: "aws",
      resourceTypeId: "ebs-volume",
      accountId,
      displayName: name || volumeId,
      fields: {
        volumeId,
        region: ctx.region,
        availabilityZone: String(vol["availabilityZone"] ?? ""),
        sizeGb: Number(vol["size"] ?? 0),
        volumeType: String(vol["volumeType"] ?? ""),
        state: String(vol["status"] ?? ""),
        encrypted: String(vol["encrypted"]) === "true",
        attachedTo,
      },
      resolvedOutputs: {},
      secretStates: [],
      externalId: volumeId,
      createdAt: String(vol["createTime"] ?? ctx.now()),
      updatedAt: ctx.now(),
    };
  });
}

export async function listVPCs(ctx: ListerContext, accountId: string): Promise<ResourceInstance[]> {
  const data = await ctx.ec2<Record<string, unknown>>("DescribeVpcs");
  const vpcs = ensureArray(
    (data["vpcSet"] as Record<string, unknown> | undefined)?.["item"],
  ) as Record<string, unknown>[];

  return vpcs.map((vpc) => {
    const vpcId = String(vpc["vpcId"] ?? "");
    const tagSet = vpc["tagSet"] as Record<string, unknown> | undefined;
    const tags = ensureArray(tagSet?.["item"]) as Record<string, unknown>[];
    const nameTag = tags.find((t) => t["key"] === "Name");
    const name = nameTag ? String(nameTag["value"] ?? "") : "";

    return {
      id: ctx.id(accountId, "vpc", vpcId),
      pluginId: "aws",
      resourceTypeId: "vpc",
      accountId,
      displayName: name || vpcId,
      fields: {
        vpcId,
        name,
        region: ctx.region,
        cidrBlock: String(vpc["cidrBlock"] ?? ""),
        state: String(vpc["state"] ?? ""),
        isDefault: String(vpc["isDefault"]) === "true",
        tenancy: String(vpc["instanceTenancy"] ?? ""),
      },
      resolvedOutputs: {},
      secretStates: [],
      externalId: vpcId,
      createdAt: ctx.now(),
      updatedAt: ctx.now(),
    };
  });
}

/**
 * Generate an EKS auth token by presigning an STS GetCallerIdentity request
 * with an `x-k8s-aws-id` header. This is what `aws eks get-token` produces
 * under the hood — doing it in-process means we don't have to invoke the AWS
 * CLI (which the host's user-level profile / assume-role config would hijack)
 * and don't need it installed on the host at all.
 *
 * Tokens are valid for 14 minutes; the lister refreshes the kubeconfig on
 * each poll cycle so resolvedOutputs always carries a fresh one.
 */
async function generateEksToken(
  creds: AwsCredentials,
  clusterName: string,
  region: string,
): Promise<string> {
  const signer = new SignatureV4({
    service: "sts",
    region,
    credentials: {
      accessKeyId: creds.accessKeyId,
      secretAccessKey: creds.secretAccessKey,
      ...(creds.sessionToken ? { sessionToken: creds.sessionToken } : {}),
    },
    sha256: Sha256,
  });
  const request = new HttpRequest({
    method: "GET",
    protocol: "https:",
    hostname: `sts.${region}.amazonaws.com`,
    path: "/",
    query: { Action: "GetCallerIdentity", Version: "2011-06-15" },
    headers: {
      host: `sts.${region}.amazonaws.com`,
      "x-k8s-aws-id": clusterName,
    },
  });
  const signed = await signer.presign(request, {
    expiresIn: 60,
    signableHeaders: new Set(["host", "x-k8s-aws-id"]),
  });
  const queryString = new URLSearchParams(signed.query as Record<string, string>).toString();
  const fullUrl = `${signed.protocol}//${signed.hostname}${signed.path}?${queryString}`;
  return `k8s-aws-v1.${toBase64Url(fullUrl)}`;
}

/** base64url without padding — works in both Node (Buffer) and browser (btoa) hosts. */
function toBase64Url(input: string): string {
  let b64: string;
  if (typeof Buffer !== "undefined") {
    b64 = Buffer.from(input, "utf8").toString("base64");
  } else {
    // btoa requires Latin-1; encode UTF-8 bytes first
    const bytes = new TextEncoder().encode(input);
    let bin = "";
    for (const b of bytes) bin += String.fromCharCode(b);
    b64 = btoa(bin);
  }
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Build a kubeconfig YAML for an EKS cluster. Embeds a presigned STS token
 * directly so consumers don't need the AWS CLI and aren't subject to the
 * host's AWS_PROFILE / shared config.
 */
async function buildEksKubeconfig(
  clusterName: string,
  endpoint: string,
  caData: string,
  region: string,
  creds: AwsCredentials,
): Promise<string> {
  const token = await generateEksToken(creds, clusterName, region);
  return [
    "apiVersion: v1",
    "kind: Config",
    "clusters:",
    `- name: ${clusterName}`,
    "  cluster:",
    `    server: ${endpoint}`,
    `    certificate-authority-data: ${caData}`,
    "contexts:",
    `- name: ${clusterName}`,
    "  context:",
    `    cluster: ${clusterName}`,
    `    user: ${clusterName}`,
    "current-context: " + clusterName,
    "users:",
    `- name: ${clusterName}`,
    "  user:",
    `    token: ${token}`,
  ].join("\n");
}

export async function listEKSClusters(
  ctx: ListerContext,
  accountId: string,
): Promise<ResourceInstance[]> {
  const listData = await ctx.jsonGet<{ clusters?: string[] }>("eks", "/clusters");
  const clusterNames = listData.clusters ?? [];
  const results: ResourceInstance[] = [];

  for (const name of clusterNames) {
    try {
      const detail = await ctx.jsonGet<{ cluster: Record<string, unknown> }>(
        "eks",
        `/clusters/${encodeURIComponent(name)}`,
      );
      const c = detail.cluster;
      const endpoint = String(c["endpoint"] ?? "");
      const caData = String(
        (c["certificateAuthority"] as Record<string, unknown> | undefined)?.["data"] ?? "",
      );

      // Fetch managed node groups so we can surface instance type, disk size, and node count
      let nodeGroupCount = 0;
      let totalNodeCount = 0;
      let instanceTypesSet = new Set<string>();
      let diskSizeGb = 0;
      try {
        const ngList = await ctx.jsonGet<{ nodegroups?: string[] }>(
          "eks",
          `/clusters/${encodeURIComponent(name)}/node-groups`,
        );
        const ngNames = ngList.nodegroups ?? [];
        nodeGroupCount = ngNames.length;
        for (const ngName of ngNames) {
          try {
            const ngDetail = await ctx.jsonGet<{ nodegroup: Record<string, unknown> }>(
              "eks",
              `/clusters/${encodeURIComponent(name)}/node-groups/${encodeURIComponent(ngName)}`,
            );
            const ng = ngDetail.nodegroup;
            const scaling = (ng["scalingConfig"] as Record<string, unknown> | undefined) ?? {};
            totalNodeCount += Number(scaling["desiredSize"] ?? 0);
            const types = (ng["instanceTypes"] as string[] | undefined) ?? [];
            for (const t of types) instanceTypesSet.add(t);
            if (!diskSizeGb) diskSizeGb = Number(ng["diskSize"] ?? 0);
          } catch {
            // Skip node groups we can't describe
          }
        }
      } catch {
        // No permission to list node groups — leave fields empty
      }

      // Don't let kubeconfig generation hide the cluster from the list — the
      // cluster might still be useful even without a working kubeconfig (e.g.
      // when SignatureV4 / Buffer aren't available in the host runtime).
      let kubeconfig = "";
      try {
        kubeconfig = await buildEksKubeconfig(name, endpoint, caData, ctx.region, ctx.creds);
      } catch (err) {
        console.error(`[eks] kubeconfig generation failed for ${name}:`, err);
      }

      results.push({
        id: ctx.id(accountId, "eks-cluster", name),
        pluginId: "aws",
        resourceTypeId: "eks-cluster",
        accountId,
        displayName: name,
        fields: {
          name,
          region: ctx.region,
          version: String(c["version"] ?? ""),
          status: String(c["status"] ?? ""),
          platformVersion: String(c["platformVersion"] ?? ""),
          roleArn: String(c["roleArn"] ?? ""),
          nodeGroupCount,
          nodeCount: totalNodeCount,
          instanceTypes: Array.from(instanceTypesSet).join(", "),
          diskSizeGb,
        },
        resolvedOutputs: {
          endpoint,
          certificateAuthority: caData,
          kubeconfig,
        },
        secretStates: [],
        externalId: name,
        createdAt: String(c["createdAt"] ?? ctx.now()),
        updatedAt: ctx.now(),
      });
    } catch (err) {
      // Skip clusters we can't describe (permission issues), but log so the
      // operator can tell the difference between "no cluster" and "described
      // but threw downstream".
      console.error(`[eks] failed to describe cluster ${name}:`, err);
    }
  }
  return results;
}

export async function listRDSInstances(
  ctx: ListerContext,
  accountId: string,
): Promise<ResourceInstance[]> {
  const data = await ctx.ec2Query<Record<string, unknown>>(
    "rds",
    "DescribeDBInstances",
    "2014-10-31",
  );
  const result = data["DescribeDBInstancesResult"] as Record<string, unknown> | undefined;
  const instances = ensureArray(
    (result?.["DBInstances"] as Record<string, unknown> | undefined)?.["DBInstance"],
  ) as Record<string, unknown>[];
  return instances.map((db) => {
    const dbId = String(db["DBInstanceIdentifier"] ?? "");
    const endpoint = db["Endpoint"] as Record<string, unknown> | undefined;
    const engine = String(db["Engine"] ?? "");
    const host = String(endpoint?.["Address"] ?? "");
    const port = String(endpoint?.["Port"] ?? "");
    const masterUsername = String(db["MasterUsername"] ?? "");
    return {
      id: ctx.id(accountId, "rds-instance", dbId),
      pluginId: "aws",
      resourceTypeId: "rds-instance",
      accountId,
      displayName: dbId,
      fields: {
        dbInstanceId: dbId,
        region: ctx.region,
        engine,
        engineVersion: String(db["EngineVersion"] ?? ""),
        instanceClass: String(db["DBInstanceClass"] ?? ""),
        status: String(db["DBInstanceStatus"] ?? ""),
        allocatedStorage: Number(db["AllocatedStorage"] ?? 0),
        availabilityZone: String(db["AvailabilityZone"] ?? ""),
        multiAZ: String(db["MultiAZ"]) === "true",
      },
      resolvedOutputs: {
        endpoint: host,
        port,
        masterUsername,
        connectionString: host ? buildRdsConnectionString(engine, masterUsername, host, port) : "",
      },
      secretStates: [],
      externalId: dbId,
      createdAt: String(db["InstanceCreateTime"] ?? ctx.now()),
      updatedAt: ctx.now(),
    };
  });
}

function buildRdsConnectionString(
  engine: string,
  username: string,
  host: string,
  port: string,
): string {
  const userPart = username ? `${username}@` : "";
  const portPart = port ? `:${port}` : "";
  if (engine.startsWith("postgres") || engine === "aurora-postgresql") {
    return `postgresql://${userPart}${host}${portPart}`;
  }
  if (engine === "mysql" || engine === "mariadb" || engine === "aurora-mysql") {
    return `mysql://${userPart}${host}${portPart}`;
  }
  if (engine.startsWith("sqlserver")) {
    return `sqlserver://${userPart}${host}${portPart}`;
  }
  return `${host}${portPart}`;
}

export async function listS3Buckets(
  ctx: ListerContext,
  accountId: string,
): Promise<ResourceInstance[]> {
  // S3 ListBuckets uses XML REST GET to the S3 endpoint
  const data = await ctx.xmlGet<Record<string, unknown>>("s3", "/");
  const bucketsContainer = data["Buckets"] as Record<string, unknown> | undefined;
  const bucketList = ensureArray(bucketsContainer?.["Bucket"]) as Record<string, unknown>[];
  return bucketList.map((b) => {
    const name = String(b["Name"] ?? "");
    return {
      id: ctx.id(accountId, "s3-bucket", name),
      pluginId: "aws",
      resourceTypeId: "s3-bucket",
      accountId,
      displayName: name,
      fields: {
        name,
        region: ctx.region,
        creationDate: String(b["CreationDate"] ?? ""),
      },
      resolvedOutputs: {
        bucketArn: `arn:aws:s3:::${name}`,
        endpoint: `https://${name}.s3.${ctx.region}.amazonaws.com`,
      },
      secretStates: [],
      externalId: name,
      createdAt: String(b["CreationDate"] ?? "") || ctx.now(),
      updatedAt: ctx.now(),
    };
  });
}

export async function listLambdaFunctions(
  ctx: ListerContext,
  accountId: string,
): Promise<ResourceInstance[]> {
  const data = await ctx.jsonGet<{ Functions?: Record<string, unknown>[] }>(
    "lambda",
    "/2015-03-31/functions",
  );
  const functions = data.Functions ?? [];
  return functions.map((fn) => {
    const name = String(fn["FunctionName"] ?? "");
    return {
      id: ctx.id(accountId, "lambda-function", name),
      pluginId: "aws",
      resourceTypeId: "lambda-function",
      accountId,
      displayName: name,
      fields: {
        name,
        region: ctx.region,
        runtime: String(fn["Runtime"] ?? ""),
        handler: String(fn["Handler"] ?? ""),
        codeSize: Number(fn["CodeSize"] ?? 0),
        memorySize: Number(fn["MemorySize"] ?? 0),
        timeout: Number(fn["Timeout"] ?? 0),
        state: String(fn["State"] ?? fn["LastUpdateStatus"] ?? "Active"),
        lastModified: String(fn["LastModified"] ?? ""),
      },
      resolvedOutputs: {
        functionArn: String(fn["FunctionArn"] ?? ""),
      },
      secretStates: [],
      externalId: name,
      createdAt: String(fn["LastModified"] ?? ctx.now()),
      updatedAt: ctx.now(),
    };
  });
}

export async function listECSServices(
  ctx: ListerContext,
  accountId: string,
): Promise<ResourceInstance[]> {
  // First list clusters, then list services in each cluster
  const clustersData = await ctx.json<{ clusterArns?: string[] }>(
    "ecs",
    "AmazonEC2ContainerServiceV20141113.ListClusters",
    {},
  );
  const clusterArns = clustersData.clusterArns ?? [];
  const results: ResourceInstance[] = [];

  for (const clusterArn of clusterArns) {
    const clusterName = clusterArn.split("/").pop() ?? clusterArn;
    try {
      const servicesListData = await ctx.json<{ serviceArns?: string[] }>(
        "ecs",
        "AmazonEC2ContainerServiceV20141113.ListServices",
        { cluster: clusterArn },
      );
      const serviceArns = servicesListData.serviceArns ?? [];
      if (serviceArns.length === 0) continue;

      const servicesData = await ctx.json<{ services?: Record<string, unknown>[] }>(
        "ecs",
        "AmazonEC2ContainerServiceV20141113.DescribeServices",
        { cluster: clusterArn, services: serviceArns },
      );

      for (const svc of servicesData.services ?? []) {
        const serviceName = String(svc["serviceName"] ?? "");
        const serviceArn = String(svc["serviceArn"] ?? "");
        results.push({
          id: ctx.id(accountId, "ecs-service", `${clusterName}/${serviceName}`),
          pluginId: "aws",
          resourceTypeId: "ecs-service",
          accountId,
          displayName: serviceName,
          fields: {
            serviceName,
            clusterName,
            region: ctx.region,
            status: String(svc["status"] ?? ""),
            launchType: String(svc["launchType"] ?? ""),
            desiredCount: Number(svc["desiredCount"] ?? 0),
            runningCount: Number(svc["runningCount"] ?? 0),
            taskDefinition:
              String(svc["taskDefinition"] ?? "")
                .split("/")
                .pop() ?? "",
          },
          resolvedOutputs: { serviceArn },
          secretStates: [],
          externalId: `${clusterName}/${serviceName}`,
          createdAt: String(svc["createdAt"] ?? ctx.now()),
          updatedAt: ctx.now(),
        });
      }
    } catch {
      // Skip clusters we can't access
    }
  }
  return results;
}

export async function listDynamoDBTables(
  ctx: ListerContext,
  accountId: string,
): Promise<ResourceInstance[]> {
  const listData = await ctx.json<{ TableNames?: string[] }>(
    "dynamodb",
    "DynamoDB_20120810.ListTables",
    {},
  );
  const tableNames = listData.TableNames ?? [];
  const results: ResourceInstance[] = [];

  for (const tableName of tableNames) {
    try {
      const detail = await ctx.json<{ Table: Record<string, unknown> }>(
        "dynamodb",
        "DynamoDB_20120810.DescribeTable",
        { TableName: tableName },
      );
      const t = detail.Table;
      const keySchema = t["KeySchema"] as Array<Record<string, string>> | undefined;
      const partitionKey = keySchema?.find((k) => k["KeyType"] === "HASH")?.["AttributeName"] ?? "";
      const sortKey = keySchema?.find((k) => k["KeyType"] === "RANGE")?.["AttributeName"] ?? "";
      const billingMode = String(
        (t["BillingModeSummary"] as Record<string, unknown> | undefined)?.["BillingMode"] ??
          "PROVISIONED",
      );
      // Stash schema + indexes as JSON so the detail renderer can show a
      // "Schema & indexes" tab without re-calling DescribeTable. The leading
      // underscore marks the field as internal — render-resource.ts strips
      // it before populating the Details key-value list.
      const indexesPayload = {
        attributeDefinitions: (t["AttributeDefinitions"] as unknown[]) ?? [],
        keySchema: (t["KeySchema"] as unknown[]) ?? [],
        globalSecondaryIndexes: (t["GlobalSecondaryIndexes"] as unknown[]) ?? [],
        localSecondaryIndexes: (t["LocalSecondaryIndexes"] as unknown[]) ?? [],
      };

      results.push({
        id: ctx.id(accountId, "dynamodb-table", tableName),
        pluginId: "aws",
        resourceTypeId: "dynamodb-table",
        accountId,
        displayName: tableName,
        fields: {
          tableName,
          region: ctx.region,
          status: String(t["TableStatus"] ?? ""),
          itemCount: Number(t["ItemCount"] ?? 0),
          sizeBytes: Number(t["TableSizeBytes"] ?? 0),
          billingMode,
          partitionKey,
          ...(sortKey ? { sortKey } : {}),
          _indexesJson: JSON.stringify(indexesPayload),
        },
        resolvedOutputs: {
          tableArn: String(t["TableArn"] ?? ""),
        },
        secretStates: [],
        externalId: tableName,
        createdAt: String(t["CreationDateTime"] ?? ctx.now()),
        updatedAt: ctx.now(),
      });
    } catch {
      // Skip tables we can't describe
    }
  }
  return results;
}

export async function listElastiCacheClusters(
  ctx: ListerContext,
  accountId: string,
): Promise<ResourceInstance[]> {
  const data = await ctx.ec2Query<Record<string, unknown>>(
    "elasticache",
    "DescribeCacheClusters",
    "2015-02-02",
    { ShowCacheNodeInfo: "true" },
  );
  const result = data["DescribeCacheClustersResult"] as Record<string, unknown> | undefined;
  const clusters = ensureArray(
    (result?.["CacheClusters"] as Record<string, unknown> | undefined)?.["CacheCluster"],
  ) as Record<string, unknown>[];
  return clusters.map((c) => {
    const clusterId = String(c["CacheClusterId"] ?? "");
    const nodesContainer = c["CacheNodes"] as Record<string, unknown> | undefined;
    const nodes = ensureArray(nodesContainer?.["CacheNode"]) as Record<string, unknown>[];
    const endpoint = nodes[0]?.["Endpoint"] as Record<string, unknown> | undefined;

    return {
      id: ctx.id(accountId, "elasticache-cluster", clusterId),
      pluginId: "aws",
      resourceTypeId: "elasticache-cluster",
      accountId,
      displayName: clusterId,
      fields: {
        clusterId,
        region: ctx.region,
        engine: String(c["Engine"] ?? ""),
        engineVersion: String(c["EngineVersion"] ?? ""),
        nodeType: String(c["CacheNodeType"] ?? ""),
        numNodes: Number(c["NumCacheNodes"] ?? 0),
        status: String(c["CacheClusterStatus"] ?? ""),
        availabilityZone: String(c["PreferredAvailabilityZone"] ?? ""),
      },
      resolvedOutputs: {
        endpoint: String(endpoint?.["Address"] ?? ""),
        port: String(endpoint?.["Port"] ?? ""),
        connectionString: endpoint?.["Address"]
          ? `${String(c["Engine"] ?? "redis")}://${String(endpoint["Address"])}:${String(endpoint["Port"] ?? 6379)}`
          : "",
      },
      secretStates: [],
      externalId: clusterId,
      createdAt: String(c["CacheClusterCreateTime"] ?? ctx.now()),
      updatedAt: ctx.now(),
    };
  });
}

export async function listSQSQueues(
  ctx: ListerContext,
  accountId: string,
): Promise<ResourceInstance[]> {
  const data = await ctx.json<{ QueueUrls?: string[] }>("sqs", "AmazonSQS.ListQueues", {});
  const queueUrls = data.QueueUrls ?? [];
  const results: ResourceInstance[] = [];

  for (const queueUrl of queueUrls) {
    try {
      const attrs = await ctx.json<{ Attributes?: Record<string, string> }>(
        "sqs",
        "AmazonSQS.GetQueueAttributes",
        {
          QueueUrl: queueUrl,
          AttributeNames: ["All"],
        },
      );
      const a = attrs.Attributes ?? {};
      const queueName = queueUrl.split("/").pop() ?? queueUrl;

      results.push({
        id: ctx.id(accountId, "sqs-queue", queueName),
        pluginId: "aws",
        resourceTypeId: "sqs-queue",
        accountId,
        displayName: queueName,
        fields: {
          queueName,
          queueUrl,
          region: ctx.region,
          approximateMessages: Number(a["ApproximateNumberOfMessages"] ?? 0),
          approximateMessagesDelayed: Number(a["ApproximateNumberOfMessagesDelayed"] ?? 0),
          approximateMessagesNotVisible: Number(a["ApproximateNumberOfMessagesNotVisible"] ?? 0),
          isFifo: queueName.endsWith(".fifo"),
        },
        resolvedOutputs: {
          queueArn: a["QueueArn"] ?? "",
        },
        secretStates: [],
        externalId: queueName,
        createdAt: String(
          a["CreatedTimestamp"]
            ? new Date(Number(a["CreatedTimestamp"]) * 1000).toISOString()
            : ctx.now(),
        ),
        updatedAt: ctx.now(),
      });
    } catch {
      // Skip queues we can't describe
    }
  }
  return results;
}

export async function listSNSTopics(
  ctx: ListerContext,
  accountId: string,
): Promise<ResourceInstance[]> {
  const data = await ctx.ec2Query<Record<string, unknown>>("sns", "ListTopics", "2010-03-31");
  const listResult = data["ListTopicsResult"] as Record<string, unknown> | undefined;
  const topicsContainer = listResult?.["Topics"] as Record<string, unknown> | undefined;
  const topicEntries = ensureArray(topicsContainer?.["member"]) as Record<string, unknown>[];
  const results: ResourceInstance[] = [];

  for (const topic of topicEntries) {
    const topicArn = String(topic["TopicArn"] ?? "");
    const topicName = topicArn.split(":").pop() ?? topicArn;
    try {
      const attrData = await ctx.ec2Query<Record<string, unknown>>(
        "sns",
        "GetTopicAttributes",
        "2010-03-31",
        { TopicArn: topicArn },
      );
      const attrResult = attrData["GetTopicAttributesResult"] as
        | Record<string, unknown>
        | undefined;
      const attrEntries = ensureArray(
        (attrResult?.["Attributes"] as Record<string, unknown> | undefined)?.["entry"],
      ) as Record<string, unknown>[];
      const a: Record<string, string> = {};
      for (const entry of attrEntries) {
        const key = String(entry["key"] ?? "");
        const value = String(entry["value"] ?? "");
        if (key) a[key] = value;
      }
      results.push({
        id: ctx.id(accountId, "sns-topic", topicName),
        pluginId: "aws",
        resourceTypeId: "sns-topic",
        accountId,
        displayName: topicName,
        fields: {
          topicName,
          topicArn,
          region: ctx.region,
          subscriptionCount: Number(a["SubscriptionsConfirmed"] ?? 0),
          isFifo: topicName.endsWith(".fifo"),
        },
        resolvedOutputs: { topicArn },
        secretStates: [],
        externalId: topicName,
        createdAt: ctx.now(),
        updatedAt: ctx.now(),
      });
    } catch {
      results.push({
        id: ctx.id(accountId, "sns-topic", topicName),
        pluginId: "aws",
        resourceTypeId: "sns-topic",
        accountId,
        displayName: topicName,
        fields: {
          topicName,
          topicArn,
          region: ctx.region,
          subscriptionCount: 0,
          isFifo: topicName.endsWith(".fifo"),
        },
        resolvedOutputs: { topicArn },
        secretStates: [],
        externalId: topicName,
        createdAt: ctx.now(),
        updatedAt: ctx.now(),
      });
    }
  }
  return results;
}

export async function listECRRepositories(
  ctx: ListerContext,
  accountId: string,
): Promise<ResourceInstance[]> {
  const data = await ctx.json<{ repositories?: Record<string, unknown>[] }>(
    "ecr",
    "AmazonEC2ContainerRegistry_V20150921.DescribeRepositories",
    {},
  );
  const repos = data.repositories ?? [];
  return repos.map((repo) => {
    const name = String(repo["repositoryName"] ?? "");
    return {
      id: ctx.id(accountId, "ecr-repository", name),
      pluginId: "aws",
      resourceTypeId: "ecr-repository",
      accountId,
      displayName: name,
      fields: {
        repositoryName: name,
        region: ctx.region,
        registryId: String(repo["registryId"] ?? ""),
        imageCount: 0, // Would need a separate DescribeImages call
        imageScanOnPush:
          (repo["imageScanningConfiguration"] as Record<string, unknown> | undefined)?.[
            "scanOnPush"
          ] === true,
        encryptionType: String(
          (repo["encryptionConfiguration"] as Record<string, unknown> | undefined)?.[
            "encryptionType"
          ] ?? "AES256",
        ),
      },
      resolvedOutputs: {
        repositoryUri: String(repo["repositoryUri"] ?? ""),
        repositoryArn: String(repo["repositoryArn"] ?? ""),
      },
      secretStates: [],
      externalId: name,
      createdAt: String(repo["createdAt"] ?? ctx.now()),
      updatedAt: ctx.now(),
    };
  });
}

export async function listSecretsManagerSecrets(
  ctx: ListerContext,
  accountId: string,
): Promise<ResourceInstance[]> {
  const data = await ctx.json<{ SecretList?: Record<string, unknown>[] }>(
    "secretsmanager",
    "secretsmanager.ListSecrets",
    {},
  );
  const secrets = data.SecretList ?? [];
  return secrets.map((s) => {
    const name = String(s["Name"] ?? "");
    return {
      id: ctx.id(accountId, "secrets-manager-secret", name),
      pluginId: "aws",
      resourceTypeId: "secrets-manager-secret",
      accountId,
      displayName: name,
      fields: {
        name,
        region: ctx.region,
        description: String(s["Description"] ?? ""),
        lastAccessedDate: String(s["LastAccessedDate"] ?? ""),
        lastChangedDate: String(s["LastChangedDate"] ?? ""),
        rotationEnabled: s["RotationEnabled"] === true,
      },
      resolvedOutputs: {
        secretArn: String(s["ARN"] ?? ""),
      },
      secretStates: [],
      externalId: name,
      createdAt: String(s["CreatedDate"] ?? ctx.now()),
      updatedAt: ctx.now(),
    };
  });
}

export async function listCloudFrontDistributions(
  ctx: ListerContext,
  accountId: string,
): Promise<ResourceInstance[]> {
  const data = await ctx.jsonGet<{
    DistributionList?: { Items?: Record<string, unknown>[] };
  }>("cloudfront", "/2020-05-31/distribution");

  const items = data.DistributionList?.Items ?? [];
  return items.map((dist) => {
    const distId = String(dist["Id"] ?? "");
    return {
      id: ctx.id(accountId, "cloudfront-distribution", distId),
      pluginId: "aws",
      resourceTypeId: "cloudfront-distribution",
      accountId,
      displayName: String(dist["Comment"] ?? "") || distId,
      fields: {
        distributionId: distId,
        domainName: String(dist["DomainName"] ?? ""),
        status: String(dist["Status"] ?? ""),
        enabled: dist["Enabled"] === true || dist["Enabled"] === "true",
        comment: String(dist["Comment"] ?? ""),
        priceClass: String(dist["PriceClass"] ?? ""),
        httpVersion: String(dist["HttpVersion"] ?? ""),
      },
      resolvedOutputs: {
        distributionArn: String(dist["ARN"] ?? ""),
      },
      secretStates: [],
      externalId: distId,
      createdAt: String(dist["LastModifiedTime"] ?? ctx.now()),
      updatedAt: ctx.now(),
    };
  });
}

export async function listIAMUsers(
  ctx: ListerContext,
  accountId: string,
): Promise<ResourceInstance[]> {
  const data = await ctx.ec2Query<Record<string, unknown>>("iam", "ListUsers", "2010-05-08");
  const listResult = data["ListUsersResult"] as Record<string, unknown> | undefined;
  const users = ensureArray(
    (listResult?.["Users"] as Record<string, unknown> | undefined)?.["member"],
  ) as Record<string, unknown>[];
  return users.map((u) => {
    const userName = String(u["UserName"] ?? "");
    return {
      id: ctx.id(accountId, "iam-user", userName),
      pluginId: "aws",
      resourceTypeId: "iam-user",
      accountId,
      displayName: userName,
      fields: {
        userName,
        userId: String(u["UserId"] ?? ""),
        path: String(u["Path"] ?? "/"),
        createDate: String(u["CreateDate"] ?? ""),
        passwordLastUsed: String(u["PasswordLastUsed"] ?? ""),
      },
      resolvedOutputs: {
        userArn: String(u["Arn"] ?? ""),
      },
      secretStates: [],
      externalId: userName,
      createdAt: String(u["CreateDate"] ?? ctx.now()),
      updatedAt: ctx.now(),
    };
  });
}
