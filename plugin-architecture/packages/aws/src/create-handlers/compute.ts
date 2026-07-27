import type { CreateResourceConfig, ResourceInstance } from "@infrawrench/plugin-base";
import { ensureArray } from "../xml.js";
import { fetchSigned } from "../signed-request.js";
import { ec2SshUsername, ec2SshUsernameFromImageName } from "../ssh-username.js";
import {
  FAMILY_SSH_USERNAME,
  instanceTypeArch,
  isImageFamily,
  resolveAmiId,
} from "../ami-lookup.js";
import { AWS_REGIONS, EC2_SIZES } from "../constants.js";
import type { AwsCreateContext } from "./shared.js";
import { createEksCluster } from "./eks.js";

/**
 * The SSH key picker submits a full public key (e.g. `ssh-ed25519 AAAA... user@host`),
 * but EC2 `RunInstances` expects `KeyName` to refer to a key pair already imported in
 * the target region. Import the material idempotently into a content-addressed name and
 * return that name. If a pair with the same hashed name already exists, AWS responds
 * with `InvalidKeyPair.Duplicate` — safe to ignore since the name is derived from the
 * key material itself.
 */
async function ensureEc2KeyPair(rctx: AwsCreateContext, publicKey: string): Promise<string> {
  const trimmed = publicKey.trim();
  const material = trimmed.split(/\s+/)[1] ?? trimmed;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(material));
  const hash = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 16);
  const keyName = `infrawrench-${hash}`;
  const base64 = btoa(trimmed);
  try {
    await rctx.ec2("ImportKeyPair", {
      KeyName: keyName,
      PublicKeyMaterial: base64,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!msg.includes("InvalidKeyPair.Duplicate")) throw e;
  }
  return keyName;
}

/**
 * Find or create a shared "infrawrench-agent-ssh" security group with TCP/22
 * open, in the region's default VPC. Used when `openSshPort=true` is submitted
 * without an explicit security group — notably the Agents VM flow, which
 * submits only field defaults. Without this, the instance lands in the default
 * security group, where port 22 is typically closed and SSH setup can never
 * reach the VM.
 */
async function ensureAgentSshSecurityGroup(rctx: AwsCreateContext): Promise<string> {
  const groupName = "infrawrench-agent-ssh";
  const vpcs = await rctx.ec2<Record<string, unknown>>("DescribeVpcs", {
    "Filter.1.Name": "is-default",
    "Filter.1.Value": "true",
  });
  const vpcSet = vpcs["vpcSet"] as Record<string, unknown> | undefined;
  const vpcItems = ensureArray(vpcSet?.["item"]) as Record<string, unknown>[];
  const vpcId = String(vpcItems[0]?.["vpcId"] ?? "");
  if (!vpcId) {
    throw new Error(
      "openSshPort requested but no default VPC exists in this region — pick a security group explicitly instead.",
    );
  }

  const existing = await rctx.ec2<Record<string, unknown>>("DescribeSecurityGroups", {
    "Filter.1.Name": "group-name",
    "Filter.1.Value": groupName,
    "Filter.2.Name": "vpc-id",
    "Filter.2.Value": vpcId,
  });
  const sgInfo = existing["securityGroupInfo"] as Record<string, unknown> | undefined;
  const sgItems = ensureArray(sgInfo?.["item"]) as Record<string, unknown>[];
  const existingId = String(sgItems[0]?.["groupId"] ?? "");
  if (existingId) return existingId;

  const created = await rctx.ec2<Record<string, unknown>>("CreateSecurityGroup", {
    GroupName: groupName,
    GroupDescription: "SSH access for Infrawrench agent VMs",
    VpcId: vpcId,
  });
  const groupId = String(created["groupId"] ?? "");
  if (!groupId) throw new Error("CreateSecurityGroup returned no groupId");
  await rctx.ec2("AuthorizeSecurityGroupIngress", {
    GroupId: groupId,
    "IpPermissions.1.IpProtocol": "tcp",
    "IpPermissions.1.FromPort": "22",
    "IpPermissions.1.ToPort": "22",
    "IpPermissions.1.IpRanges.1.CidrIp": "0.0.0.0/0",
    "IpPermissions.1.IpRanges.1.Description": "SSH for Infrawrench agent VMs",
  });
  return groupId;
}

/**
 * List IAM roles via the legacy XML Query API. Returns the raw role records.
 * Service-linked roles (path `/aws-service-role/`) are excluded since
 * `iam:PassRole` rejects them.
 */
async function listIamRoles(ctx: AwsCreateContext): Promise<Record<string, unknown>[]> {
  const raw = await ctx
    .ec2Query<Record<string, unknown>>("iam", "ListRoles", "2010-05-08")
    .catch(() => ({}) as Record<string, unknown>);
  const result = raw["ListRolesResult"] as Record<string, unknown> | undefined;
  const roles = ensureArray(
    (result?.["Roles"] as Record<string, unknown> | undefined)?.["member"],
  ) as Record<string, unknown>[];
  return roles.filter((r) => !String(r["Path"] ?? "/").startsWith("/aws-service-role/"));
}

/**
 * Filter IAM roles to those assumable by a given service principal (e.g.
 * "eks.amazonaws.com"). Falls back to name hints when the trust policy isn't
 * decipherable, and to the full list when no matches are found at all.
 */
function pickRolesForPrincipal(
  roles: Record<string, unknown>[],
  principal: string,
  nameHints: string[],
): { id: string; label: string }[] {
  const matches = roles.filter((r) => {
    const raw = r["AssumeRolePolicyDocument"];
    if (typeof raw === "string" && raw.length > 0) {
      try {
        const decoded = decodeURIComponent(raw);
        if (decoded.includes(principal)) return true;
      } catch {
        /* fall through to name heuristic */
      }
    }
    const name = String(r["RoleName"] ?? "").toLowerCase();
    return nameHints.some((hint) => name.includes(hint));
  });
  const pool = matches.length > 0 ? matches : roles;
  return pool.map((r) => ({
    id: String(r["Arn"] ?? ""),
    label: String(r["RoleName"] ?? ""),
  }));
}

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc ^= data[i]!;
    for (let j = 0; j < 8; j++) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export async function computeGetCreateConfig(
  ctx: AwsCreateContext,
  typeId: string,
  _parentResourceId?: string,
): Promise<CreateResourceConfig | null> {
  if (typeId === "ec2-instance") {
    return {
      fields: [
        {
          key: "name",
          label: "Instance Name",
          kind: "text",
          required: true,
          description: "Name tag for the EC2 instance",
        },
        {
          key: "region",
          label: "Region",
          kind: "region-picker",
          required: true,
          regions: AWS_REGIONS,
          defaultValue: ctx.creds.region,
        },
        {
          key: "instanceType",
          label: "Instance Type",
          kind: "size-picker",
          required: true,
          sizes: EC2_SIZES,
        },
        {
          key: "imageId",
          label: "AMI",
          kind: "image-picker",
          required: true,
          images: [
            {
              id: "al2023",
              label: "Amazon Linux 2023",
              category: "Amazon Linux",
              family: "al2023",
            },
            {
              id: "amzn2",
              label: "Amazon Linux 2",
              category: "Amazon Linux",
              family: "amzn2",
            },
            {
              id: "ubuntu-2604",
              label: "Ubuntu 26.04 LTS (Resolute Raccoon)",
              category: "Ubuntu",
              family: "ubuntu-2604",
            },
            {
              id: "ubuntu-2404",
              label: "Ubuntu 24.04 LTS (Noble Numbat)",
              category: "Ubuntu",
              family: "ubuntu-2404",
            },
            {
              id: "ubuntu-2204",
              label: "Ubuntu 22.04 LTS (Jammy Jellyfish)",
              category: "Ubuntu",
              family: "ubuntu-2204",
            },
            {
              id: "debian-13",
              label: "Debian 13 (Trixie)",
              category: "Debian",
              family: "debian-13",
            },
            {
              id: "debian-12",
              label: "Debian 12 (Bookworm)",
              category: "Debian",
              family: "debian-12",
            },
            {
              id: "rhel-10",
              label: "Red Hat Enterprise Linux 10",
              category: "RHEL",
              family: "rhel-10",
            },
            {
              id: "rhel-9",
              label: "Red Hat Enterprise Linux 9",
              category: "RHEL",
              family: "rhel-9",
            },
            {
              id: "sles-15",
              label: "SUSE Linux Enterprise Server 15",
              category: "SUSE",
              family: "sles-15",
            },
          ],
        },
        {
          key: "diskSizeGb",
          label: "Root Volume Size",
          kind: "disk-slider",
          required: false,
          minGb: 8,
          maxGb: 2048,
          defaultGb: 20,
          stepGb: 1,
        },
        {
          key: "sshKey",
          label: "SSH Key",
          kind: "ssh-key-picker",
          required: false,
          description: "Key pair name for SSH access",
        },
        {
          key: "addExtraDisk",
          label: "Extra EBS Volume",
          kind: "select",
          required: false,
          defaultValue: "false",
          options: [
            { id: "false", label: "None" },
            { id: "true", label: "Add an extra volume" },
          ],
        },
        {
          key: "extraDiskSizeGb",
          label: "Extra Volume Size",
          kind: "disk-slider",
          required: false,
          minGb: 10,
          maxGb: 16384,
          defaultGb: 100,
          stepGb: 10,
          showWhen: { fieldKey: "addExtraDisk", fieldValue: "true" },
        },
        {
          key: "extraDiskType",
          label: "Extra Volume Type",
          kind: "select",
          required: false,
          defaultValue: "gp3",
          options: [
            { id: "gp3", label: "gp3 (General Purpose SSD)" },
            { id: "gp2", label: "gp2 (General Purpose SSD)" },
            { id: "io2", label: "io2 (Provisioned IOPS SSD)" },
            { id: "st1", label: "st1 (Throughput Optimized HDD)" },
            { id: "sc1", label: "sc1 (Cold HDD)" },
          ],
          showWhen: { fieldKey: "addExtraDisk", fieldValue: "true" },
        },
        {
          key: "network",
          label: "VPC Network",
          kind: "resource-picker",
          required: false,
          description: "VPC network to attach the instance to",
          associationSources: [{ pluginId: "aws", resourceTypeId: "vpc", outputKey: "vpcId" }],
          scopeFromFieldKey: "region",
        },
        {
          key: "securityGroup",
          label: "Security Group (firewall)",
          kind: "resource-picker",
          required: false,
          description: "Apply an existing security group to the instance",
          associationSources: [
            { pluginId: "aws", resourceTypeId: "security-group", outputKey: "groupId" },
          ],
          scopeFromFieldKey: "region",
          actions: [
            {
              id: "create-sg",
              label: "+ Create new firewall",
              description:
                "Create a security group in the selected region, open the chosen ports, and attach it to this instance.",
              submitLabel: "Create firewall",
              formFields: [
                {
                  key: "sgName",
                  label: "Name",
                  kind: "text",
                  required: true,
                  placeholder: "e.g. web-server-fw",
                  description: "Shown in the AWS console; max 255 chars.",
                },
                {
                  key: "sgAllowSsh",
                  label: "Allow SSH (TCP/22)",
                  kind: "select",
                  required: false,
                  defaultValue: "true",
                  options: [
                    { id: "true", label: "Yes" },
                    { id: "false", label: "No" },
                  ],
                },
                {
                  key: "sgAllowHttp",
                  label: "Allow HTTP (TCP/80)",
                  kind: "select",
                  required: false,
                  defaultValue: "false",
                  options: [
                    { id: "true", label: "Yes" },
                    { id: "false", label: "No" },
                  ],
                },
                {
                  key: "sgAllowHttps",
                  label: "Allow HTTPS (TCP/443)",
                  kind: "select",
                  required: false,
                  defaultValue: "false",
                  options: [
                    { id: "true", label: "Yes" },
                    { id: "false", label: "No" },
                  ],
                },
                {
                  key: "sgSourceCidr",
                  label: "Source CIDR",
                  kind: "text",
                  required: false,
                  defaultValue: "0.0.0.0/0",
                  description:
                    "IP range allowed to reach the open ports. 0.0.0.0/0 means anywhere on the internet — restrict to your office/VPN range for production.",
                },
              ],
            },
          ],
        },
      ],
    };
  }
  if (typeId === "eks-cluster") {
    const allRoles = await listIamRoles(ctx);
    const clusterRoleOptions = pickRolesForPrincipal(allRoles, "eks.amazonaws.com", ["eks"]);
    const nodeRoleOptions = pickRolesForPrincipal(allRoles, "ec2.amazonaws.com", [
      "eks",
      "node",
      "worker",
    ]);
    return {
      fields: [
        { key: "name", label: "Cluster Name", kind: "text", required: true },
        {
          key: "region",
          label: "Region",
          kind: "region-picker",
          required: true,
          regions: AWS_REGIONS,
          defaultValue: ctx.creds.region,
        },
        {
          key: "version",
          label: "Kubernetes Version",
          kind: "select",
          required: true,
          options: [
            { id: "1.35", label: "1.35" },
            { id: "1.34", label: "1.34" },
            { id: "1.33", label: "1.33" },
            { id: "1.32", label: "1.32" },
            { id: "1.31", label: "1.31" },
            { id: "1.30", label: "1.30" },
          ],
          defaultValue: "1.34",
        },
        {
          key: "roleArn",
          label: "Cluster Role",
          kind: clusterRoleOptions.length > 0 ? "select" : "text",
          required: true,
          ...(clusterRoleOptions.length > 0 ? { options: clusterRoleOptions } : {}),
          description: "IAM role assumed by the EKS control plane",
          actions: [
            {
              id: "generate-role",
              label: "+ Generate role",
              description:
                "Create a fresh IAM role with AmazonEKSClusterPolicy attached and select it.",
            },
          ],
        },
        {
          key: "instanceType",
          label: "Node Instance Type",
          kind: "size-picker",
          required: true,
          sizes: EC2_SIZES,
          defaultValue: "t3.medium",
        },
        {
          key: "diskSizeGb",
          label: "Disk Per Node",
          kind: "disk-slider",
          required: false,
          minGb: 20,
          maxGb: 1024,
          defaultGb: 20,
          stepGb: 10,
          description: "Root EBS volume size attached to each worker node.",
        },
        {
          key: "nodeCount",
          label: "Node Count",
          kind: "number",
          required: true,
          defaultValue: "2",
          minValue: 1,
          stepValue: 1,
          description: "Initial number of nodes in the managed node group.",
        },
        {
          key: "nodeRoleArn",
          label: "Node Role",
          kind: nodeRoleOptions.length > 0 ? "select" : "text",
          required: true,
          ...(nodeRoleOptions.length > 0 ? { options: nodeRoleOptions } : {}),
          description: "IAM role attached to each worker node",
          actions: [
            {
              id: "generate-role",
              label: "+ Generate role",
              description:
                "Create a fresh IAM role with the standard EKS worker policies attached.",
            },
          ],
        },
      ],
    };
  }
  if (typeId === "ebs-volume") {
    return {
      fields: [
        { key: "name", label: "Name (Tag)", kind: "text", required: false },
        {
          key: "region",
          label: "Region",
          kind: "region-picker",
          required: true,
          regions: AWS_REGIONS,
          defaultValue: ctx.creds.region,
        },
        {
          key: "volumeType",
          label: "Volume Type",
          kind: "select",
          required: true,
          options: [
            { id: "gp3", label: "gp3 (General Purpose SSD)" },
            { id: "gp2", label: "gp2 (General Purpose SSD)" },
            { id: "io2", label: "io2 (Provisioned IOPS SSD)" },
            { id: "st1", label: "st1 (Throughput Optimized HDD)" },
            { id: "sc1", label: "sc1 (Cold HDD)" },
          ],
          defaultValue: "gp3",
        },
        {
          key: "sizeGb",
          label: "Size (GB)",
          kind: "number",
          required: true,
          defaultValue: "20",
          minValue: 1,
          maxValue: 16384,
        },
        {
          key: "availabilityZone",
          label: "Availability Zone",
          kind: "text",
          required: true,
          description: "e.g. us-east-1a",
        },
      ],
    };
  }
  if (typeId === "elastic-ip") {
    return {
      fields: [
        { key: "name", label: "Name (Tag)", kind: "text", required: false },
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
  if (typeId === "auto-scaling-group") {
    // Fetch launch templates for the selector
    const ltData = await ctx
      .ec2<Record<string, unknown>>("DescribeLaunchTemplates")
      .catch(() => ({}) as Record<string, unknown>);
    const ltSet = ltData["launchTemplatesSet"] as Record<string, unknown> | undefined;
    const ltItems = Array.isArray(ltSet?.["item"])
      ? (ltSet!["item"] as Record<string, unknown>[])
      : ltSet?.["item"]
        ? [ltSet["item"] as Record<string, unknown>]
        : [];
    const ltOptions = ltItems.map((lt) => ({
      id: String(lt["launchTemplateId"] ?? ""),
      label: `${lt["launchTemplateName"]} (${lt["launchTemplateId"]})`,
    }));
    return {
      fields: [
        { key: "name", label: "Group Name", kind: "text", required: true },
        {
          key: "region",
          label: "Region",
          kind: "region-picker",
          required: true,
          regions: AWS_REGIONS,
          defaultValue: ctx.creds.region,
        },
        {
          key: "launchTemplateId",
          label: "Launch Template",
          kind: ltOptions.length > 0 ? "select" : "text",
          required: true,
          ...(ltOptions.length > 0 ? { options: ltOptions } : {}),
          description: "Launch Template ID",
        },
        {
          key: "minSize",
          label: "Min Size",
          kind: "number",
          required: true,
          defaultValue: "1",
        },
        {
          key: "maxSize",
          label: "Max Size",
          kind: "number",
          required: true,
          defaultValue: "3",
        },
        {
          key: "desiredCapacity",
          label: "Desired Capacity",
          kind: "number",
          required: true,
          defaultValue: "1",
        },
      ],
    };
  }
  if (typeId === "ecs-service") {
    // Fetch clusters and task definition families for selectors
    const [clustersData, taskFamiliesData] = await Promise.all([
      ctx
        .json<{
          clusterArns?: string[];
        }>("ecs", "AmazonEC2ContainerServiceV20141113.ListClusters", {})
        .catch(() => ({ clusterArns: [] as string[] })),
      ctx
        .json<{
          families?: string[];
        }>("ecs", "AmazonEC2ContainerServiceV20141113.ListTaskDefinitionFamilies", {})
        .catch(() => ({ families: [] as string[] })),
    ]);
    const clusterOptions = (clustersData.clusterArns ?? []).map((arn) => ({
      id: arn.split("/").pop() ?? arn,
      label: arn.split("/").pop() ?? arn,
    }));
    const taskFamilyOptions = (taskFamiliesData.families ?? []).map((f) => ({
      id: f,
      label: f,
    }));
    return {
      fields: [
        { key: "serviceName", label: "Service Name", kind: "text", required: true },
        {
          key: "region",
          label: "Region",
          kind: "region-picker",
          required: true,
          regions: AWS_REGIONS,
          defaultValue: ctx.creds.region,
        },
        {
          key: "cluster",
          label: "Cluster",
          kind: clusterOptions.length > 0 ? "select" : "text",
          required: true,
          ...(clusterOptions.length > 0 ? { options: clusterOptions } : {}),
        },
        {
          key: "taskDefinition",
          label: "Task Definition Family",
          kind: taskFamilyOptions.length > 0 ? "select" : "text",
          required: true,
          ...(taskFamilyOptions.length > 0 ? { options: taskFamilyOptions } : {}),
          description: "Task definition family name (uses latest ACTIVE revision)",
        },
        {
          key: "launchType",
          label: "Launch Type",
          kind: "select",
          required: true,
          options: [
            { id: "FARGATE", label: "Fargate" },
            { id: "EC2", label: "EC2" },
          ],
          defaultValue: "FARGATE",
        },
        {
          key: "desiredCount",
          label: "Desired Count",
          kind: "number",
          required: true,
          defaultValue: "1",
        },
      ],
    };
  }
  if (typeId === "batch-job-queue") {
    // Fetch compute environments for the selector
    const ceData = await ctx
      .json<{
        computeEnvironments?: Array<{
          computeEnvironmentName: string;
          computeEnvironmentArn: string;
        }>;
      }>("batch", "AWSBatch.DescribeComputeEnvironments", {})
      .catch(() => ({
        computeEnvironments: [] as Array<{
          computeEnvironmentName: string;
          computeEnvironmentArn: string;
        }>,
      }));
    const ceOptions = (ceData.computeEnvironments ?? []).map((ce) => ({
      id: ce.computeEnvironmentArn ?? ce.computeEnvironmentName,
      label: ce.computeEnvironmentName,
    }));
    return {
      fields: [
        { key: "jobQueueName", label: "Queue Name", kind: "text", required: true },
        {
          key: "region",
          label: "Region",
          kind: "region-picker",
          required: true,
          regions: AWS_REGIONS,
          defaultValue: ctx.creds.region,
        },
        {
          key: "computeEnvironment",
          label: "Compute Environment",
          kind: ceOptions.length > 0 ? "select" : "text",
          required: true,
          ...(ceOptions.length > 0 ? { options: ceOptions } : {}),
          description: "Compute environment ARN",
        },
        {
          key: "priority",
          label: "Priority",
          kind: "number",
          required: false,
          defaultValue: "1",
        },
        {
          key: "state",
          label: "State",
          kind: "select",
          required: false,
          options: [
            { id: "ENABLED", label: "Enabled" },
            { id: "DISABLED", label: "Disabled" },
          ],
          defaultValue: "ENABLED",
        },
      ],
    };
  }
  if (typeId === "lambda-function") {
    // Fetch IAM roles for the execution role selector. Service-linked roles
    // (path `/aws-service-role/`) cannot be used as Lambda execution roles —
    // PassRole rejects them — so exclude them from the list.
    const rolesRaw = await ctx
      .ec2Query<Record<string, unknown>>("iam", "ListRoles", "2010-05-08")
      .catch(() => ({}) as Record<string, unknown>);
    const rolesResult = rolesRaw["ListRolesResult"] as Record<string, unknown> | undefined;
    const rolesList = ensureArray(
      (rolesResult?.["Roles"] as Record<string, unknown> | undefined)?.["member"],
    ) as Record<string, unknown>[];
    const assumableByLambda = (r: Record<string, unknown>): boolean => {
      // Try the trust policy first — that's the authoritative signal. The
      // policy is URL-encoded JSON in `AssumeRolePolicyDocument`.
      const raw = r["AssumeRolePolicyDocument"];
      if (typeof raw === "string" && raw.length > 0) {
        try {
          const decoded = decodeURIComponent(raw);
          if (decoded.includes("lambda.amazonaws.com")) return true;
        } catch {
          /* fall through to name heuristic */
        }
      }
      // Fallback: roles whose name/path hint at Lambda or generic execution
      // use. Avoids hiding e.g. "MyAppExecutionRole" which has no `lambda`
      // substring but might still be assumable.
      const name = String(r["RoleName"] ?? "").toLowerCase();
      return name.includes("lambda") || name.includes("execution");
    };
    const usableRoles = rolesList.filter(
      (r) => !String(r["Path"] ?? "/").startsWith("/aws-service-role/"),
    );
    const matched = usableRoles.filter(assumableByLambda);
    const allRoleOptions = (matched.length > 0 ? matched : usableRoles).map((r) => ({
      id: String(r["Arn"] ?? ""),
      label: String(r["RoleName"] ?? ""),
    }));
    const nodejsDefault = `exports.handler = async (event) => {\n  return { statusCode: 200, body: "Hello from Lambda!" };\n};\n`;
    const pythonDefault = `def lambda_handler(event, context):\n    return {"statusCode": 200, "body": "Hello from Lambda!"}\n`;
    const rubyDefault = `def lambda_handler(event:, context:)\n  { statusCode: 200, body: "Hello from Lambda!" }\nend\n`;
    return {
      fields: [
        { key: "name", label: "Function Name", kind: "text", required: true },
        {
          key: "region",
          label: "Region",
          kind: "region-picker",
          required: true,
          regions: AWS_REGIONS,
          defaultValue: ctx.creds.region,
        },
        {
          key: "runtime",
          label: "Runtime",
          kind: "select",
          required: true,
          options: [
            { id: "nodejs24.x", label: "Node.js 24.x" },
            { id: "nodejs22.x", label: "Node.js 22.x" },
            { id: "nodejs20.x", label: "Node.js 20.x" },
            { id: "python3.14", label: "Python 3.14" },
            { id: "python3.13", label: "Python 3.13" },
            { id: "python3.12", label: "Python 3.12" },
            { id: "ruby3.4", label: "Ruby 3.4" },
            { id: "ruby3.3", label: "Ruby 3.3" },
          ],
          defaultValue: "nodejs24.x",
          description:
            "Java and .NET runtimes require pre-built deployment packages; use the AWS console to upload those.",
        },
        {
          key: "role",
          label: "Execution Role",
          kind: allRoleOptions.length > 0 ? "select" : "text",
          required: true,
          ...(allRoleOptions.length > 0 ? { options: allRoleOptions } : {}),
          description: "IAM role ARN for the function's execution role",
          actions: [
            {
              id: "generate-role",
              label: "+ Generate role",
              description:
                "Create a fresh IAM role with AWSLambdaBasicExecutionRole attached and select it.",
            },
          ],
        },
        {
          key: "code_nodejs",
          label: "Source Code (index.js)",
          kind: "code",
          codeLanguage: "javascript",
          required: true,
          showWhen: {
            fieldKey: "runtime",
            fieldValues: ["nodejs24.x", "nodejs22.x", "nodejs20.x"],
          },
          defaultValue: nodejsDefault,
          description: "Saved as index.js. Handler entry point is index.handler.",
        },
        {
          key: "code_python",
          label: "Source Code (lambda_function.py)",
          kind: "code",
          codeLanguage: "python",
          required: true,
          showWhen: {
            fieldKey: "runtime",
            fieldValues: ["python3.14", "python3.13", "python3.12"],
          },
          defaultValue: pythonDefault,
          description:
            "Saved as lambda_function.py. Handler entry point is lambda_function.lambda_handler.",
        },
        {
          key: "code_ruby",
          label: "Source Code (lambda_function.rb)",
          kind: "code",
          codeLanguage: "ruby",
          required: true,
          showWhen: { fieldKey: "runtime", fieldValues: ["ruby3.4", "ruby3.3"] },
          defaultValue: rubyDefault,
          description:
            "Saved as lambda_function.rb. Handler entry point is lambda_function.lambda_handler.",
        },
        {
          key: "memorySize",
          label: "Memory (MB)",
          kind: "number",
          required: false,
          defaultValue: "128",
        },
        {
          key: "timeout",
          label: "Timeout (s)",
          kind: "number",
          required: false,
          defaultValue: "3",
        },
      ],
    };
  }
  return null;
}

export async function computeCreateResource(
  ctx: AwsCreateContext,
  typeId: string,
  accountId: string,
  fields: Record<string, string>,
  _parentResourceId?: string,
): Promise<ResourceInstance | null> {
  if (typeId === "ec2-instance") {
    const region = fields["region"] ?? ctx.creds.region;
    const rctx = ctx.withRegion(region);
    const instanceType = fields["instanceType"] ?? "t3.micro";
    const arch = instanceTypeArch(instanceType);
    const imageField = fields["imageId"] ?? "";
    // Image picker submits a family slug (e.g. "ubuntu-2404"). Resolve it
    // to a region+arch-specific AMI now. If the caller already supplied a
    // raw ami-xxx id (e.g. from automation), pass it through unchanged.
    let resolvedImageId = imageField;
    if (isImageFamily(imageField)) {
      resolvedImageId = await resolveAmiId(rctx, imageField, arch);
    }
    const params: Record<string, string> = {
      ImageId: resolvedImageId,
      InstanceType: instanceType,
      MinCount: "1",
      MaxCount: "1",
    };
    if (fields["sshKey"]) {
      params["KeyName"] = await ensureEc2KeyPair(rctx, fields["sshKey"]);
    }
    if (fields["diskSizeGb"]) {
      params["BlockDeviceMapping.1.DeviceName"] = "/dev/xvda";
      params["BlockDeviceMapping.1.Ebs.VolumeSize"] = fields["diskSizeGb"];
      params["BlockDeviceMapping.1.Ebs.VolumeType"] = "gp3";
    }
    if (fields["addExtraDisk"] === "true") {
      params["BlockDeviceMapping.2.DeviceName"] = "/dev/sdf";
      params["BlockDeviceMapping.2.Ebs.VolumeSize"] = String(fields["extraDiskSizeGb"] ?? 100);
      params["BlockDeviceMapping.2.Ebs.VolumeType"] = fields["extraDiskType"] ?? "gp3";
      params["BlockDeviceMapping.2.Ebs.DeleteOnTermination"] = "false";
    }

    const network = fields["network"];
    if (network) {
      params["SubnetId"] = network;
    }

    const securityGroup = fields["securityGroup"];
    if (securityGroup) {
      params["SecurityGroupId.1"] = securityGroup;
    } else if (fields["openSshPort"] === "true") {
      params["SecurityGroupId.1"] = await ensureAgentSshSecurityGroup(rctx);
    }

    const data = await rctx.ec2<Record<string, unknown>>("RunInstances", params);
    const instancesSet = data["instancesSet"] as Record<string, unknown> | undefined;
    const instances = ensureArray(instancesSet?.["item"]) as Record<string, unknown>[];
    const inst = instances[0];
    if (!inst) throw new Error("EC2 RunInstances returned no instance");

    const instanceId = String(inst["instanceId"] ?? "");

    if (fields["name"]) {
      await rctx.ec2("CreateTags", {
        "ResourceId.1": instanceId,
        "Tag.1.Key": "Name",
        "Tag.1.Value": fields["name"],
      });
    }

    return {
      id: ctx.makeId(accountId, "ec2-instance", instanceId),
      pluginId: "aws",
      resourceTypeId: "ec2-instance",
      accountId,
      displayName: fields["name"] || instanceId,
      fields: {
        name: fields["name"] ?? "",
        region,
        instanceId,
        instanceType: String(inst["instanceType"] ?? ""),
        availabilityZone: String(
          (inst["placement"] as Record<string, unknown> | undefined)?.["availabilityZone"] ?? "",
        ),
        state: "pending",
        imageId: String(inst["imageId"] ?? ""),
        vpcId: String(inst["vpcId"] ?? ""),
        subnetId: String(inst["subnetId"] ?? ""),
        // When the user picked a family from the image-picker we know the
        // username for free; for a raw `ami-…` ID we'd need DescribeImages
        // for the name to derive it, so we let it fall through to the
        // host's default rather than spend an extra API call here.
        sshUsername: isImageFamily(imageField)
          ? FAMILY_SSH_USERNAME[imageField]
          : ec2SshUsername(imageField) || ec2SshUsernameFromImageName(imageField),
      },
      resolvedOutputs: {
        publicIp: "",
        privateIp: String(inst["privateIpAddress"] ?? ""),
        publicDns: "",
      },
      secretStates: [],
      externalId: instanceId,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }
  if (typeId === "eks-cluster") {
    return createEksCluster(ctx, accountId, fields);
  }
  if (typeId === "ebs-volume") {
    const region = fields["region"] ?? ctx.creds.region;
    const rctx = ctx.withRegion(region);
    const params: Record<string, string> = {
      VolumeType: fields["volumeType"] ?? "gp3",
      Size: fields["sizeGb"] ?? "20",
      AvailabilityZone: fields["availabilityZone"] ?? "",
    };
    const data = await rctx.ec2<Record<string, unknown>>("CreateVolume", params);
    const volumeId = String(data["volumeId"] ?? "");
    if (fields["name"]) {
      await rctx.ec2("CreateTags", {
        "ResourceId.1": volumeId,
        "Tag.1.Key": "Name",
        "Tag.1.Value": fields["name"],
      });
    }
    return {
      id: ctx.makeId(accountId, "ebs-volume", volumeId),
      pluginId: "aws",
      resourceTypeId: "ebs-volume",
      accountId,
      displayName: fields["name"] || volumeId,
      fields: {
        volumeId,
        region,
        availabilityZone: fields["availabilityZone"] ?? "",
        sizeGb: Number(fields["sizeGb"] ?? 20),
        volumeType: fields["volumeType"] ?? "gp3",
        state: "creating",
        encrypted: false,
        attachedTo: "",
      },
      resolvedOutputs: {},
      secretStates: [],
      externalId: volumeId,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }
  if (typeId === "elastic-ip") {
    const region = fields["region"] ?? ctx.creds.region;
    const rctx = ctx.withRegion(region);
    const data = await rctx.ec2<Record<string, unknown>>("AllocateAddress", {
      Domain: "vpc",
    });
    const allocationId = String(data["allocationId"] ?? "");
    const publicIp = String(data["publicIp"] ?? "");
    if (fields["name"]) {
      await rctx.ec2("CreateTags", {
        "ResourceId.1": allocationId,
        "Tag.1.Key": "Name",
        "Tag.1.Value": fields["name"],
      });
    }
    return {
      id: ctx.makeId(accountId, "elastic-ip", allocationId),
      pluginId: "aws",
      resourceTypeId: "elastic-ip",
      accountId,
      displayName: publicIp || allocationId,
      fields: {
        allocationId,
        region,
        publicIp,
        associationId: "",
        instanceId: "",
        networkInterfaceId: "",
        domain: "vpc",
      },
      resolvedOutputs: { publicIp },
      secretStates: [],
      externalId: allocationId,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }
  if (typeId === "auto-scaling-group") {
    const region = fields["region"] ?? ctx.creds.region;
    const rctx = ctx.withRegion(region);
    const name = fields["name"] ?? "";
    const launchTemplateId = fields["launchTemplateId"] ?? "";
    const minSize = fields["minSize"] ?? "1";
    const maxSize = fields["maxSize"] ?? "3";
    const desiredCapacity = fields["desiredCapacity"] ?? "1";
    await rctx.ec2Query("autoscaling", "CreateAutoScalingGroup", "2011-01-01", {
      AutoScalingGroupName: name,
      "LaunchTemplate.LaunchTemplateId": launchTemplateId,
      "LaunchTemplate.Version": "$Default",
      MinSize: minSize,
      MaxSize: maxSize,
      DesiredCapacity: desiredCapacity,
    });
    const now = new Date().toISOString();
    return {
      id: ctx.makeId(accountId, "auto-scaling-group", name),
      pluginId: "aws",
      resourceTypeId: "auto-scaling-group",
      accountId,
      displayName: name,
      fields: {
        name,
        region,
        minSize: Number(minSize),
        maxSize: Number(maxSize),
        desiredCapacity: Number(desiredCapacity),
        status: "",
        healthCheckType: "EC2",
        availabilityZones: "",
        launchTemplate: launchTemplateId,
        instanceCount: 0,
      },
      resolvedOutputs: { autoScalingGroupArn: "" },
      secretStates: [],
      externalId: name,
      createdAt: now,
      updatedAt: now,
    };
  }
  if (typeId === "ecs-service") {
    const region = fields["region"] ?? ctx.creds.region;
    const rctx = ctx.withRegion(region);
    const serviceName = fields["serviceName"] ?? "";
    const cluster = fields["cluster"] ?? "";
    const taskDefinition = fields["taskDefinition"] ?? "";
    const launchType = fields["launchType"] ?? "FARGATE";
    const desiredCount = Number(fields["desiredCount"] ?? "1");
    const body: Record<string, unknown> = {
      serviceName,
      cluster,
      taskDefinition,
      launchType,
      desiredCount,
    };
    // Fargate requires network configuration with subnets
    if (launchType === "FARGATE") {
      body["networkConfiguration"] = {
        awsvpcConfiguration: {
          assignPublicIp: "ENABLED",
          subnets: [],
        },
      };
    }
    const result = await rctx.json<{ service?: Record<string, unknown> }>(
      "ecs",
      "AmazonEC2ContainerServiceV20141113.CreateService",
      body,
    );
    const svc = result.service ?? {};
    const now = new Date().toISOString();
    return {
      id: ctx.makeId(accountId, "ecs-service", `${cluster}/${serviceName}`),
      pluginId: "aws",
      resourceTypeId: "ecs-service",
      accountId,
      displayName: serviceName,
      fields: {
        serviceName,
        region,
        clusterName: cluster,
        status: String(svc["status"] ?? "ACTIVE"),
        launchType,
        desiredCount,
        runningCount: 0,
        taskDefinition,
      },
      resolvedOutputs: {
        serviceArn: String(svc["serviceArn"] ?? ""),
      },
      secretStates: [],
      externalId: `${cluster}/${serviceName}`,
      createdAt: now,
      updatedAt: now,
    };
  }
  if (typeId === "batch-job-queue") {
    const region = fields["region"] ?? ctx.creds.region;
    const rctx = ctx.withRegion(region);
    const jobQueueName = fields["jobQueueName"] ?? "";
    const computeEnvironment = fields["computeEnvironment"] ?? "";
    const priority = Number(fields["priority"] ?? "1");
    const state = fields["state"] ?? "ENABLED";
    const result = await rctx.json<Record<string, unknown>>("batch", "AWSBatch.CreateJobQueue", {
      jobQueueName,
      state,
      priority,
      computeEnvironmentOrder: [{ order: 1, computeEnvironment }],
    });
    const now = new Date().toISOString();
    return {
      id: ctx.makeId(accountId, "batch-job-queue", jobQueueName),
      pluginId: "aws",
      resourceTypeId: "batch-job-queue",
      accountId,
      displayName: jobQueueName,
      fields: {
        jobQueueName,
        region,
        state,
        status: "CREATING",
        priority,
        schedulingPolicyArn: "",
      },
      resolvedOutputs: {
        jobQueueArn: String(result["jobQueueArn"] ?? ""),
      },
      secretStates: [],
      externalId: jobQueueName,
      createdAt: now,
      updatedAt: now,
    };
  }
  if (typeId === "lambda-function") {
    const region = fields["region"] ?? ctx.creds.region;
    const rctx = ctx.withRegion(region);
    const name = fields["name"] ?? "";
    const runtime = fields["runtime"] ?? "nodejs24.x";
    const role = fields["role"] ?? "";
    const memorySize = fields["memorySize"] ?? "128";
    const timeout = fields["timeout"] ?? "3";

    let handler: string;
    let code: string;
    let ext: string;
    if (runtime.startsWith("python")) {
      handler = "lambda_function.lambda_handler";
      code = fields["code_python"] ?? "";
      ext = ".py";
    } else if (runtime.startsWith("ruby")) {
      handler = "lambda_function.lambda_handler";
      code = fields["code_ruby"] ?? "";
      ext = ".rb";
    } else {
      handler = "index.handler";
      code = fields["code_nodejs"] ?? "";
      ext = ".js";
    }

    // Construct a minimal ZIP file containing the handler
    const encoder = new TextEncoder();
    const codeBytes = encoder.encode(code);
    const fileName = handler.split(".")[0] ?? "index";
    const fullName = fileName + ext;
    const nameBytes = encoder.encode(fullName);

    // Minimal ZIP: local file header + data + central directory + end of central directory
    const crc = crc32(codeBytes);
    const localHeader = new Uint8Array(30 + nameBytes.length);
    const ldv = new DataView(localHeader.buffer);
    ldv.setUint32(0, 0x04034b50, true); // local file header signature
    ldv.setUint16(4, 20, true); // version needed
    ldv.setUint16(6, 0, true); // flags
    ldv.setUint16(8, 0, true); // compression: stored
    ldv.setUint16(10, 0, true); // mod time
    ldv.setUint16(12, 0, true); // mod date
    ldv.setUint32(14, crc, true); // crc-32
    ldv.setUint32(18, codeBytes.length, true); // compressed size
    ldv.setUint32(22, codeBytes.length, true); // uncompressed size
    ldv.setUint16(26, nameBytes.length, true); // file name length
    ldv.setUint16(28, 0, true); // extra field length
    localHeader.set(nameBytes, 30);

    const centralDir = new Uint8Array(46 + nameBytes.length);
    const cdv = new DataView(centralDir.buffer);
    cdv.setUint32(0, 0x02014b50, true); // central directory signature
    cdv.setUint16(4, 20, true); // version made by
    cdv.setUint16(6, 20, true); // version needed
    cdv.setUint16(8, 0, true); // flags
    cdv.setUint16(10, 0, true); // compression: stored
    cdv.setUint16(12, 0, true); // mod time
    cdv.setUint16(14, 0, true); // mod date
    cdv.setUint32(16, crc, true); // crc-32
    cdv.setUint32(20, codeBytes.length, true); // compressed size
    cdv.setUint32(24, codeBytes.length, true); // uncompressed size
    cdv.setUint16(28, nameBytes.length, true); // file name length
    cdv.setUint16(30, 0, true); // extra field length
    cdv.setUint16(32, 0, true); // file comment length
    cdv.setUint16(34, 0, true); // disk number start
    cdv.setUint16(36, 0, true); // internal file attributes
    cdv.setUint32(38, 0, true); // external file attributes
    cdv.setUint32(42, 0, true); // relative offset of local header

    const centralDirOffset = localHeader.length + codeBytes.length;
    const eocd = new Uint8Array(22);
    const ev = new DataView(eocd.buffer);
    ev.setUint32(0, 0x06054b50, true); // end of central directory signature
    ev.setUint16(4, 0, true); // disk number
    ev.setUint16(6, 0, true); // disk with central directory
    ev.setUint16(8, 1, true); // entries on this disk
    ev.setUint16(10, 1, true); // total entries
    ev.setUint32(12, centralDir.length, true); // central directory size
    ev.setUint32(16, centralDirOffset, true); // central directory offset
    ev.setUint16(20, 0, true); // comment length

    centralDir.set(nameBytes, 46);

    const zipBuffer = new Uint8Array(
      localHeader.length + codeBytes.length + centralDir.length + eocd.length,
    );
    zipBuffer.set(localHeader, 0);
    zipBuffer.set(codeBytes, localHeader.length);
    zipBuffer.set(centralDir, centralDirOffset);
    zipBuffer.set(eocd, centralDirOffset + centralDir.length);

    let binary = "";
    for (let i = 0; i < zipBuffer.length; i++) {
      binary += String.fromCharCode(zipBuffer[i]!);
    }
    const zipBase64 = btoa(binary);

    const host = rctx.hostForService("lambda");
    const url = `https://${host}/2015-03-31/functions`;
    const bodyStr = JSON.stringify({
      FunctionName: name,
      Runtime: runtime,
      Role: role,
      Handler: handler,
      Code: { ZipFile: zipBase64 },
      MemorySize: parseInt(memorySize, 10),
      Timeout: parseInt(timeout, 10),
    });
    const res = await fetchSigned({
      method: "POST",
      url,
      headers: { Host: host, "Content-Type": "application/json" },
      body: bodyStr,
      service: "lambda",
      credentials: rctx.creds,
    });
    const result = (await res.json()) as Record<string, unknown>;
    const functionArn = String(result["FunctionArn"] ?? "");
    const now = new Date().toISOString();
    return {
      id: ctx.makeId(accountId, "lambda-function", name),
      pluginId: "aws",
      resourceTypeId: "lambda-function",
      accountId,
      displayName: name,
      fields: {
        name,
        region,
        runtime,
        handler,
        codeSize: String(codeBytes.length),
        memorySize,
        timeout,
        state: "Active",
        lastModified: now,
      },
      resolvedOutputs: { functionArn },
      secretStates: [],
      externalId: name,
      createdAt: now,
      updatedAt: now,
    };
  }
  return null;
}
