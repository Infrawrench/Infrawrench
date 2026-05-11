import type { CreateResourceConfig, ResourceInstance } from "@infrawrench/plugin-base";
import { ensureArray } from "../auth.js";
import { signRequest } from "../signed-request.js";
import { ec2SshUsername } from "../ssh-username.js";
import { AWS_REGIONS, EC2_SIZES } from "../constants.js";
import type { AwsCreateContext } from "./shared.js";

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
              id: "ami-0c02fb55956c7d316",
              label: "Amazon Linux 2023",
              category: "Amazon Linux",
              family: "al2023",
            },
            {
              id: "ami-0261755bbcb8c4a84",
              label: "Amazon Linux 2",
              category: "Amazon Linux",
              family: "amzn2",
            },
            {
              id: "ami-0c7217cdde317cfec",
              label: "Ubuntu 22.04 LTS",
              category: "Ubuntu",
              family: "ubuntu-2204",
            },
            {
              id: "ami-0e001c9271cf7f3b9",
              label: "Ubuntu 24.04 LTS",
              category: "Ubuntu",
              family: "ubuntu-2404",
            },
            {
              id: "ami-0b0dcb5067f052a63",
              label: "Debian 12",
              category: "Debian",
              family: "debian-12",
            },
            {
              id: "ami-0dfcb1ef8fc5fd105",
              label: "Red Hat Enterprise Linux 9",
              category: "RHEL",
              family: "rhel-9",
            },
            {
              id: "ami-0b5eea76982371e91",
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
        },
      ],
    };
  }
  if (typeId === "eks-cluster") {
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
            { id: "1.32", label: "1.32" },
            { id: "1.31", label: "1.31" },
            { id: "1.30", label: "1.30" },
            { id: "1.29", label: "1.29" },
            { id: "1.28", label: "1.28" },
          ],
          defaultValue: "1.31",
        },
      ],
    };
  }
  if (typeId === "ebs-volume") {
    return {
      fields: [
        { key: "name", label: "Name (Tag)", kind: "text", required: false },
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
      fields: [{ key: "name", label: "Name (Tag)", kind: "text", required: false }],
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
    // Fetch IAM roles for the execution role selector
    const rolesRaw = await ctx
      .ec2Query<Record<string, unknown>>("iam", "ListRoles", "2010-05-08")
      .catch(() => ({}) as Record<string, unknown>);
    const rolesResult = rolesRaw["ListRolesResult"] as Record<string, unknown> | undefined;
    const rolesList = ensureArray(
      (rolesResult?.["Roles"] as Record<string, unknown> | undefined)?.["member"],
    ) as Record<string, unknown>[];
    const roleOptions = rolesList
      .filter(
        (r) =>
          String(r["Arn"] ?? "").includes("lambda") ||
          String(r["RoleName"] ?? "")
            .toLowerCase()
            .includes("lambda") ||
          String(r["RoleName"] ?? "")
            .toLowerCase()
            .includes("execution"),
      )
      .map((r) => ({ id: String(r["Arn"] ?? ""), label: String(r["RoleName"] ?? "") }));
    const allRoleOptions =
      roleOptions.length > 0
        ? roleOptions
        : rolesList.map((r) => ({
            id: String(r["Arn"] ?? ""),
            label: String(r["RoleName"] ?? ""),
          }));
    return {
      fields: [
        { key: "name", label: "Function Name", kind: "text", required: true },
        {
          key: "runtime",
          label: "Runtime",
          kind: "select",
          required: true,
          options: [
            { id: "nodejs22.x", label: "Node.js 22.x" },
            { id: "nodejs20.x", label: "Node.js 20.x" },
            { id: "python3.13", label: "Python 3.13" },
            { id: "python3.12", label: "Python 3.12" },
            { id: "java21", label: "Java 21" },
            { id: "dotnet8", label: ".NET 8" },
            { id: "ruby3.3", label: "Ruby 3.3" },
          ],
          defaultValue: "nodejs22.x",
        },
        {
          key: "role",
          label: "Execution Role",
          kind: allRoleOptions.length > 0 ? "select" : "text",
          required: true,
          ...(allRoleOptions.length > 0 ? { options: allRoleOptions } : {}),
          description: "IAM role ARN for the function's execution role",
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
    const params: Record<string, string> = {
      ImageId: fields["imageId"] ?? "",
      InstanceType: fields["instanceType"] ?? "t3.micro",
      MinCount: "1",
      MaxCount: "1",
    };
    if (fields["sshKey"]) params["KeyName"] = fields["sshKey"];
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
    }

    const data = await ctx.ec2<Record<string, unknown>>("RunInstances", params);
    const instancesSet = data["instancesSet"] as Record<string, unknown> | undefined;
    const instances = ensureArray(instancesSet?.["item"]) as Record<string, unknown>[];
    const inst = instances[0];
    if (!inst) throw new Error("EC2 RunInstances returned no instance");

    const instanceId = String(inst["instanceId"] ?? "");

    // Tag with name
    if (fields["name"]) {
      await ctx.ec2("CreateTags", {
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
        instanceId,
        instanceType: String(inst["instanceType"] ?? ""),
        availabilityZone: String(
          (inst["placement"] as Record<string, unknown> | undefined)?.["availabilityZone"] ?? "",
        ),
        state: "pending",
        imageId: String(inst["imageId"] ?? ""),
        vpcId: String(inst["vpcId"] ?? ""),
        subnetId: String(inst["subnetId"] ?? ""),
        sshUsername: ec2SshUsername(fields["imageId"] ?? ""),
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
  if (typeId === "ebs-volume") {
    const params: Record<string, string> = {
      VolumeType: fields["volumeType"] ?? "gp3",
      Size: fields["sizeGb"] ?? "20",
      AvailabilityZone: fields["availabilityZone"] ?? "",
    };
    const data = await ctx.ec2<Record<string, unknown>>("CreateVolume", params);
    const volumeId = String(data["volumeId"] ?? "");
    if (fields["name"]) {
      await ctx.ec2("CreateTags", {
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
    const data = await ctx.ec2<Record<string, unknown>>("AllocateAddress", {
      Domain: "vpc",
    });
    const allocationId = String(data["allocationId"] ?? "");
    const publicIp = String(data["publicIp"] ?? "");
    if (fields["name"]) {
      await ctx.ec2("CreateTags", {
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
    const name = fields["name"] ?? "";
    const launchTemplateId = fields["launchTemplateId"] ?? "";
    const minSize = fields["minSize"] ?? "1";
    const maxSize = fields["maxSize"] ?? "3";
    const desiredCapacity = fields["desiredCapacity"] ?? "1";
    await ctx.ec2Query("autoscaling", "CreateAutoScalingGroup", "2011-01-01", {
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
    const result = await ctx.json<{ service?: Record<string, unknown> }>(
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
    const jobQueueName = fields["jobQueueName"] ?? "";
    const computeEnvironment = fields["computeEnvironment"] ?? "";
    const priority = Number(fields["priority"] ?? "1");
    const state = fields["state"] ?? "ENABLED";
    const result = await ctx.json<Record<string, unknown>>("batch", "AWSBatch.CreateJobQueue", {
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
    const name = fields["name"] ?? "";
    const runtime = fields["runtime"] ?? "nodejs22.x";
    const role = fields["role"] ?? "";
    const memorySize = fields["memorySize"] ?? "128";
    const timeout = fields["timeout"] ?? "3";

    // Build a minimal inline handler based on runtime
    let handler = "index.handler";
    let code = "";
    if (runtime.startsWith("python")) {
      handler = "lambda_function.lambda_handler";
      code =
        'def lambda_handler(event, context):\n    return {"statusCode": 200, "body": "Hello from Lambda!"}';
    } else if (runtime.startsWith("nodejs")) {
      code =
        'exports.handler = async (event) => { return { statusCode: 200, body: "Hello from Lambda!" }; };';
    } else if (runtime.startsWith("ruby")) {
      handler = "lambda_function.lambda_handler";
      code =
        'def lambda_handler(event:, context:)\n  { statusCode: 200, body: "Hello from Lambda!" }\nend';
    } else {
      code = "// placeholder handler";
    }

    // Construct a minimal ZIP file containing the handler
    const encoder = new TextEncoder();
    const codeBytes = encoder.encode(code);
    const fileName = handler.split(".")[0] ?? "index";
    const ext = runtime.startsWith("python") ? ".py" : runtime.startsWith("ruby") ? ".rb" : ".js";
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

    // Base64 encode
    let binary = "";
    for (let i = 0; i < zipBuffer.length; i++) {
      binary += String.fromCharCode(zipBuffer[i]!);
    }
    const zipBase64 = btoa(binary);

    const host = ctx.hostForService("lambda");
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
    const headers = await signRequest({
      method: "POST",
      url,
      headers: { Host: host, "Content-Type": "application/json" },
      body: bodyStr,
      service: "lambda",
      credentials: ctx.creds,
    });
    const res = await fetch(url, { method: "POST", headers, body: bodyStr });
    if (!res.ok)
      throw new Error(`Lambda CreateFunction failed: ${res.status}: ${await res.text()}`);
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
