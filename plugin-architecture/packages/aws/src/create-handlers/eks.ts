import type { ResourceInstance } from "@infrawrench/plugin-base";
import { ensureArray, type AwsCredentials } from "../auth.js";
import { fetchSigned } from "../signed-request.js";
import { instanceTypeArch } from "../ami-lookup.js";
import type { AwsCreateContext } from "./shared.js";

/**
 * EKS cluster provisioning. Lifted out of compute.ts because the control-plane
 * + node-group dance is independent of the EC2 RunInstances flow that
 * dominates that file.
 */

interface SubnetInfo {
  subnetId: string;
  availabilityZone: string;
}

function readSubnetInfo(items: Record<string, unknown>[]): SubnetInfo[] {
  return items
    .map((s) => ({
      subnetId: String(s["subnetId"] ?? ""),
      availabilityZone: String(s["availabilityZone"] ?? ""),
    }))
    .filter((s) => s.subnetId && s.availabilityZone);
}

/**
 * Discover default-VPC subnets in the region. EKS requires at least two
 * subnets in different AZs, so this is the minimum viable set when the user
 * hasn't configured a custom VPC. Falls back to all subnets in the default
 * VPC if no default-for-az subnets exist.
 */
async function discoverDefaultSubnets(rctx: AwsCreateContext): Promise<SubnetInfo[]> {
  const data = await rctx.ec2<Record<string, unknown>>("DescribeSubnets", {
    "Filter.1.Name": "default-for-az",
    "Filter.1.Value.1": "true",
  });
  const set = data["subnetSet"] as Record<string, unknown> | undefined;
  const items = ensureArray(set?.["item"]) as Record<string, unknown>[];
  const subnets = readSubnetInfo(items);
  if (subnets.length >= 2) return subnets;

  // Fallback: try the default VPC's subnets even if default-for-az isn't set
  const vpcData = await rctx.ec2<Record<string, unknown>>("DescribeVpcs", {
    "Filter.1.Name": "is-default",
    "Filter.1.Value.1": "true",
  });
  const vpcSet = vpcData["vpcSet"] as Record<string, unknown> | undefined;
  const vpcs = ensureArray(vpcSet?.["item"]) as Record<string, unknown>[];
  const defaultVpcId = String(vpcs[0]?.["vpcId"] ?? "");
  if (!defaultVpcId) return subnets;
  const subnetData = await rctx.ec2<Record<string, unknown>>("DescribeSubnets", {
    "Filter.1.Name": "vpc-id",
    "Filter.1.Value.1": defaultVpcId,
  });
  const subnetSet = subnetData["subnetSet"] as Record<string, unknown> | undefined;
  return readSubnetInfo(ensureArray(subnetSet?.["item"]) as Record<string, unknown>[]);
}

/**
 * EKS rejects control-plane subnets in AZs it doesn't support (e.g. us-east-1e).
 * The 400 response includes a `validZones` array — pull it out so we can retry
 * with only the supported AZs. The error body is truncated to 400 chars by
 * `fetchSigned`, which can cut JSON.parse off mid-string, so we regex-match
 * the array contents directly rather than trying to parse JSON.
 */
function parseValidZones(err: unknown): string[] | null {
  const msg = err instanceof Error ? err.message : String(err ?? "");
  const match = msg.match(/"validZones"\s*:\s*\[([^\]]*)\]/);
  if (!match || !match[1]) return null;
  const zones = match[1]
    .split(",")
    .map((s) => s.trim().replace(/^"|"$/g, ""))
    .filter(Boolean);
  return zones.length > 0 ? zones : null;
}

function pickAmiType(instanceType: string): string {
  return instanceTypeArch(instanceType) === "arm64"
    ? "AL2023_ARM_64_STANDARD"
    : "AL2023_x86_64_STANDARD";
}

async function eksFetch<T>(
  rctx: AwsCreateContext,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<T> {
  const host = rctx.hostForService("eks");
  const url = `https://${host}${path}`;
  const init: {
    method: "GET" | "POST";
    url: string;
    headers: Record<string, string>;
    body?: string;
    service: string;
    credentials: AwsCredentials;
  } = {
    method,
    url,
    service: "eks",
    credentials: rctx.creds,
    headers: { "content-type": "application/json" },
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  const res = await fetchSigned(init);
  const text = await res.text();
  return text ? (JSON.parse(text) as T) : ({} as T);
}

export async function createEksCluster(
  ctx: AwsCreateContext,
  accountId: string,
  fields: Record<string, string>,
): Promise<ResourceInstance> {
  const region = fields["region"] ?? ctx.creds.region;
  const rctx = ctx.withRegion(region);
  const name = fields["name"] ?? "";
  const version = fields["version"] ?? "1.34";
  const roleArn = fields["roleArn"] ?? "";
  const nodeRoleArn = fields["nodeRoleArn"] ?? "";
  const instanceType = fields["instanceType"] ?? "t3.medium";
  const requestedDiskSize = Number.parseInt(fields["diskSizeGb"] ?? "20", 10);
  const diskSize =
    Number.isFinite(requestedDiskSize) && requestedDiskSize >= 20 ? requestedDiskSize : 20;
  const requestedNodeCount = Number.parseInt(fields["nodeCount"] ?? "2", 10);
  const nodeCount =
    Number.isFinite(requestedNodeCount) && requestedNodeCount > 0 ? requestedNodeCount : 2;

  if (!roleArn) throw new Error("Cluster Role is required (use + Generate role to mint one).");
  if (!nodeRoleArn) throw new Error("Node Role is required (use + Generate role to mint one).");

  const allSubnets = await discoverDefaultSubnets(rctx);
  if (allSubnets.length < 2) {
    throw new Error(
      `EKS needs at least two subnets in different AZs; found ${allSubnets.length} in region ${region}. Create a VPC with public subnets first.`,
    );
  }

  // Pick one subnet per AZ — EKS rejects multiple subnets in the same AZ for
  // the control plane and we'll trim further if specific AZs are unsupported.
  let chosenSubnets = Array.from(
    allSubnets
      .reduce(
        (m, s) => (m.has(s.availabilityZone) ? m : m.set(s.availabilityZone, s)),
        new Map<string, SubnetInfo>(),
      )
      .values(),
  );

  const buildClusterBody = (subnetInfos: SubnetInfo[]) => ({
    name,
    version,
    roleArn,
    resourcesVpcConfig: {
      subnetIds: subnetInfos.map((s) => s.subnetId),
      endpointPublicAccess: true,
      endpointPrivateAccess: false,
    },
  });

  try {
    await eksFetch(rctx, "POST", "/clusters", buildClusterBody(chosenSubnets));
  } catch (e) {
    // EKS rejects subnets in unsupported AZs (e.g. us-east-1e). The 400 body
    // lists supported zones — retry with only those.
    const validZones = parseValidZones(e);
    if (!validZones) throw e;
    const filtered = chosenSubnets.filter((s) => validZones.includes(s.availabilityZone));
    if (filtered.length < 2) {
      throw new Error(
        `EKS rejected the default subnets in ${region}. Supported AZs are ${validZones.join(", ")}, but the default VPC only has subnets in ${chosenSubnets
          .map((s) => s.availabilityZone)
          .join(", ")}.`,
      );
    }
    chosenSubnets = filtered;
    await eksFetch(rctx, "POST", "/clusters", buildClusterBody(chosenSubnets));
  }

  // EKS control planes take 9–13 minutes to reach ACTIVE, and node groups
  // can only be created once the cluster is ACTIVE. Doing this synchronously
  // would block the HTTP request for ~15 min, which any reverse proxy will
  // time out. Return the cluster in CREATING state now and finish the node
  // group provisioning in the background — subsequent listings (via the
  // poller) will pick up the active cluster + node group once they exist.
  provisionEksNodeGroupInBackground(rctx, {
    name,
    subnets: chosenSubnets.map((s) => s.subnetId),
    instanceType,
    diskSize,
    nodeCount,
    nodeRoleArn,
  });

  const now = new Date().toISOString();
  return {
    id: ctx.makeId(accountId, "eks-cluster", name),
    pluginId: "aws",
    resourceTypeId: "eks-cluster",
    accountId,
    displayName: name,
    fields: {
      name,
      region,
      version,
      status: "CREATING",
      platformVersion: "",
      roleArn,
      nodeGroupCount: 0,
      nodeCount,
      instanceTypes: instanceType,
      diskSizeGb: diskSize,
    },
    resolvedOutputs: {
      endpoint: "",
      certificateAuthority: "",
      kubeconfig: "",
    },
    secretStates: [],
    externalId: name,
    createdAt: now,
    updatedAt: now,
  };
}

interface NodeGroupProvisionRequest {
  name: string;
  subnets: string[];
  instanceType: string;
  diskSize: number;
  nodeCount: number;
  nodeRoleArn: string;
}

/**
 * Fire-and-forget: poll EKS for cluster ACTIVE, then create the managed node
 * group. We don't surface failures to the caller (the HTTP request returned
 * long ago) but log so an operator can diagnose. The Node process stays
 * alive while servers run, which is the normal case.
 */
function provisionEksNodeGroupInBackground(
  rctx: AwsCreateContext,
  req: NodeGroupProvisionRequest,
): void {
  void (async () => {
    const deadline = Date.now() + 25 * 60 * 1000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 30_000));
      try {
        const detail = await eksFetch<{ cluster: Record<string, unknown> }>(
          rctx,
          "GET",
          `/clusters/${encodeURIComponent(req.name)}`,
        );
        const status = String(detail.cluster["status"] ?? "");
        if (status === "ACTIVE") break;
        if (status === "FAILED") {
          console.error(`[eks] cluster ${req.name} reached FAILED — not creating node group`);
          return;
        }
      } catch (e) {
        console.error(`[eks] poll for ${req.name} failed:`, e);
      }
    }
    try {
      await eksFetch(rctx, "POST", `/clusters/${encodeURIComponent(req.name)}/node-groups`, {
        nodegroupName: `${req.name}-default-pool`,
        scalingConfig: { minSize: 1, maxSize: req.nodeCount, desiredSize: req.nodeCount },
        subnets: req.subnets,
        instanceTypes: [req.instanceType],
        diskSize: req.diskSize,
        nodeRole: req.nodeRoleArn,
        amiType: pickAmiType(req.instanceType),
        capacityType: "ON_DEMAND",
      });
    } catch (e) {
      console.error(`[eks] node group creation for ${req.name} failed:`, e);
    }
  })();
}
