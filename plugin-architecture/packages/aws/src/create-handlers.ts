import type {
  CreateResourceConfig,
  ResourceInstance,
  PolicyOption,
} from "@infrawrench/plugin-base";
import { signRequest, parseXml, ensureArray } from "./auth.js";
import type { AwsCredentials } from "./auth.js";
import { ec2SshUsername } from "./ssh-username.js";
import { AWS_REGIONS, EC2_SIZES } from "./constants.js";

export interface AwsCreateContext {
  creds: AwsCredentials;
  hostForService(service: string): string;
  ec2<T>(action: string, params?: Record<string, string>): Promise<T>;
  json<T>(service: string, target: string, body: Record<string, unknown>): Promise<T>;
  ec2Query<T>(
    service: string,
    action: string,
    version: string,
    params?: Record<string, string>,
  ): Promise<T>;
  queryPost<T>(
    service: string,
    action: string,
    version: string,
    params?: Record<string, string>,
  ): Promise<T>;
  xmlGet<T>(service: string, path?: string): Promise<T>;
  makeId(accountId: string, typeId: string, externalId: string): string;
  listAllIAMPolicies(scope: "AWS" | "Local" | "All"): Promise<Array<Record<string, unknown>>>;
  policiesToOptions(raw: Array<Record<string, unknown>>, category: string): PolicyOption[];
  getResource(typeId: string, resourceId: string, accountId: string): Promise<ResourceInstance>;
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

function parsePolicyArns(value: string | undefined): string[] {
  if (!value) return [];
  try {
    const arr = JSON.parse(value);
    return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export async function awsGetCreateConfig(
  ctx: AwsCreateContext,
  typeId: string,
  parentResourceId?: string,
): Promise<CreateResourceConfig> {
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
  if (typeId === "s3-bucket") {
    return {
      fields: [
        {
          key: "name",
          label: "Bucket Name",
          kind: "text",
          required: true,
          description: "Globally unique S3 bucket name",
        },
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
  if (typeId === "vpc") {
    return {
      fields: [
        { key: "name", label: "Name", kind: "text", required: true },
        {
          key: "cidrBlock",
          label: "CIDR Block",
          kind: "text",
          required: true,
          defaultValue: "10.0.0.0/16",
          description: "IPv4 CIDR block (e.g. 10.0.0.0/16)",
        },
      ],
    };
  }
  if (typeId === "security-group") {
    return {
      fields: [
        { key: "groupName", label: "Group Name", kind: "text", required: true },
        { key: "description", label: "Description", kind: "text", required: true },
        {
          key: "vpcId",
          label: "VPC ID",
          kind: "text",
          required: false,
          description: "VPC to create in (defaults to default VPC)",
        },
      ],
    };
  }
  if (typeId === "sqs-queue") {
    return {
      fields: [
        { key: "queueName", label: "Queue Name", kind: "text", required: true },
        {
          key: "fifo",
          label: "FIFO Queue",
          kind: "select",
          required: false,
          options: [
            { id: "false", label: "Standard" },
            { id: "true", label: "FIFO" },
          ],
          defaultValue: "false",
        },
      ],
    };
  }
  if (typeId === "sns-topic") {
    return {
      fields: [
        { key: "topicName", label: "Topic Name", kind: "text", required: true },
        {
          key: "fifo",
          label: "FIFO Topic",
          kind: "select",
          required: false,
          options: [
            { id: "false", label: "Standard" },
            { id: "true", label: "FIFO" },
          ],
          defaultValue: "false",
        },
      ],
    };
  }
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
  if (typeId === "ecr-repository") {
    return {
      fields: [
        { key: "repositoryName", label: "Repository Name", kind: "text", required: true },
        {
          key: "imageTagMutability",
          label: "Image Tag Mutability",
          kind: "select",
          required: true,
          options: [
            { id: "MUTABLE", label: "Mutable" },
            { id: "IMMUTABLE", label: "Immutable" },
          ],
          defaultValue: "MUTABLE",
        },
        {
          key: "scanOnPush",
          label: "Scan on Push",
          kind: "select",
          required: true,
          options: [
            { id: "true", label: "Enabled" },
            { id: "false", label: "Disabled" },
          ],
          defaultValue: "true",
        },
      ],
    };
  }
  if (typeId === "efs-file-system") {
    return {
      fields: [
        { key: "name", label: "Name", kind: "text", required: false },
        {
          key: "performanceMode",
          label: "Performance Mode",
          kind: "select",
          required: true,
          options: [
            { id: "generalPurpose", label: "General Purpose" },
            { id: "maxIO", label: "Max I/O" },
          ],
          defaultValue: "generalPurpose",
        },
        {
          key: "throughputMode",
          label: "Throughput Mode",
          kind: "select",
          required: true,
          options: [
            { id: "elastic", label: "Elastic" },
            { id: "bursting", label: "Bursting" },
          ],
          defaultValue: "elastic",
        },
        {
          key: "encrypted",
          label: "Encrypted",
          kind: "select",
          required: true,
          options: [
            { id: "true", label: "Yes" },
            { id: "false", label: "No" },
          ],
          defaultValue: "true",
        },
      ],
    };
  }
  if (typeId === "route53-hosted-zone") {
    return {
      fields: [
        {
          key: "name",
          label: "Domain Name",
          kind: "text",
          required: true,
          description: "e.g. example.com",
        },
        { key: "comment", label: "Comment", kind: "text", required: false },
      ],
    };
  }
  if (typeId === "cloudwatch-log-group") {
    return {
      fields: [
        {
          key: "logGroupName",
          label: "Log Group Name",
          kind: "text",
          required: true,
          description: "e.g. /aws/lambda/my-function",
        },
        {
          key: "retentionInDays",
          label: "Retention (days)",
          kind: "select",
          required: false,
          options: [
            { id: "0", label: "Never expire" },
            { id: "1", label: "1 day" },
            { id: "7", label: "7 days" },
            { id: "14", label: "14 days" },
            { id: "30", label: "30 days" },
            { id: "60", label: "60 days" },
            { id: "90", label: "90 days" },
            { id: "180", label: "6 months" },
            { id: "365", label: "1 year" },
          ],
          defaultValue: "0",
        },
      ],
    };
  }
  if (typeId === "elastic-ip") {
    return {
      fields: [{ key: "name", label: "Name (Tag)", kind: "text", required: false }],
    };
  }
  if (typeId === "secrets-manager-secret") {
    return {
      fields: [
        { key: "name", label: "Secret Name", kind: "text", required: true },
        { key: "description", label: "Description", kind: "text", required: false },
        { key: "secretValue", label: "Secret Value", kind: "text", required: true },
      ],
    };
  }
  if (typeId === "ssm-parameter") {
    return {
      fields: [
        {
          key: "name",
          label: "Parameter Name",
          kind: "text",
          required: true,
          description: "e.g. /app/config/key",
        },
        {
          key: "type",
          label: "Type",
          kind: "select",
          required: true,
          options: [
            { id: "String", label: "String" },
            { id: "SecureString", label: "SecureString" },
            { id: "StringList", label: "StringList" },
          ],
          defaultValue: "String",
        },
        { key: "value", label: "Value", kind: "text", required: true },
      ],
    };
  }
  if (typeId === "kinesis-stream") {
    return {
      fields: [
        { key: "streamName", label: "Stream Name", kind: "text", required: true },
        {
          key: "shardCount",
          label: "Shard Count",
          kind: "number",
          required: true,
          defaultValue: "1",
          minValue: 1,
          maxValue: 500,
        },
      ],
    };
  }
  if (typeId === "glue-database") {
    return {
      fields: [
        { key: "name", label: "Database Name", kind: "text", required: true },
        { key: "description", label: "Description", kind: "text", required: false },
      ],
    };
  }
  if (typeId === "internet-gateway") {
    return {
      fields: [{ key: "name", label: "Name (Tag)", kind: "text", required: false }],
    };
  }
  if (typeId === "subnet") {
    const hasParent = !!parentResourceId;
    const fields: CreateResourceConfig["fields"] = [];
    if (!hasParent) {
      fields.push({ key: "vpcId", label: "VPC ID", kind: "text", required: true });
    }
    fields.push(
      {
        key: "cidrBlock",
        label: "CIDR Block",
        kind: "text",
        required: true,
        description: "e.g. 10.0.1.0/24",
      },
      {
        key: "availabilityZone",
        label: "Availability Zone",
        kind: "text",
        required: true,
        description: "e.g. us-east-1a",
      },
      { key: "name", label: "Name (Tag)", kind: "text", required: false },
    );
    return { fields };
  }
  if (typeId === "nat-gateway") {
    return {
      fields: [
        { key: "subnetId", label: "Subnet ID", kind: "text", required: true },
        {
          key: "allocationId",
          label: "Elastic IP Allocation ID",
          kind: "text",
          required: true,
          description: "Allocation ID of an Elastic IP",
        },
      ],
    };
  }
  if (typeId === "target-group") {
    const hasParent = !!parentResourceId;
    const fields: CreateResourceConfig["fields"] = [
      { key: "name", label: "Name", kind: "text", required: true },
      {
        key: "protocol",
        label: "Protocol",
        kind: "select",
        required: true,
        options: [
          { id: "HTTP", label: "HTTP" },
          { id: "HTTPS", label: "HTTPS" },
          { id: "TCP", label: "TCP" },
          { id: "TLS", label: "TLS" },
          { id: "UDP", label: "UDP" },
        ],
        defaultValue: "HTTP",
      },
      {
        key: "port",
        label: "Port",
        kind: "number",
        required: true,
        defaultValue: "80",
        minValue: 1,
        maxValue: 65535,
      },
    ];
    if (!hasParent) {
      fields.push({ key: "vpcId", label: "VPC ID", kind: "text", required: true });
    }
    fields.push({
      key: "targetType",
      label: "Target Type",
      kind: "select",
      required: true,
      options: [
        { id: "instance", label: "Instance" },
        { id: "ip", label: "IP" },
        { id: "lambda", label: "Lambda" },
        { id: "alb", label: "ALB" },
      ],
      defaultValue: "instance",
    });
    return { fields };
  }
  if (typeId === "alb") {
    return {
      fields: [
        { key: "name", label: "Name", kind: "text", required: true },
        {
          key: "subnets",
          label: "Subnet IDs",
          kind: "text",
          required: true,
          description: "Comma-separated subnet IDs (at least 2)",
        },
        {
          key: "scheme",
          label: "Scheme",
          kind: "select",
          required: true,
          options: [
            { id: "internet-facing", label: "Internet-facing" },
            { id: "internal", label: "Internal" },
          ],
          defaultValue: "internet-facing",
        },
      ],
    };
  }
  if (typeId === "route53-record-set") {
    const hasParent = !!parentResourceId;
    const fields: CreateResourceConfig["fields"] = [];
    if (!hasParent) {
      fields.push({
        key: "hostedZoneId",
        label: "Hosted Zone ID",
        kind: "text",
        required: true,
      });
    }
    fields.push(
      {
        key: "name",
        label: "Record Name",
        kind: "text",
        required: true,
        description: "e.g. www.example.com",
      },
      {
        key: "type",
        label: "Record Type",
        kind: "select",
        required: true,
        options: [
          { id: "A", label: "A" },
          { id: "AAAA", label: "AAAA" },
          { id: "CNAME", label: "CNAME" },
          { id: "MX", label: "MX" },
          { id: "TXT", label: "TXT" },
          { id: "NS", label: "NS" },
          { id: "SRV", label: "SRV" },
          { id: "PTR", label: "PTR" },
          { id: "CAA", label: "CAA" },
        ],
        defaultValue: "A",
      },
      {
        key: "ttl",
        label: "TTL",
        kind: "number",
        required: true,
        defaultValue: "300",
        minValue: 0,
        maxValue: 2147483647,
      },
      {
        key: "value",
        label: "Value",
        kind: "text",
        required: true,
        description: "Record value (e.g. IP address)",
      },
    );
    return { fields };
  }
  if (typeId === "cloudwatch-alarm") {
    return {
      fields: [
        { key: "alarmName", label: "Alarm Name", kind: "text", required: true },
        {
          key: "namespace",
          label: "Namespace",
          kind: "text",
          required: true,
          description: "e.g. AWS/EC2",
        },
        {
          key: "metricName",
          label: "Metric Name",
          kind: "text",
          required: true,
          description: "e.g. CPUUtilization",
        },
        {
          key: "comparisonOperator",
          label: "Comparison Operator",
          kind: "select",
          required: true,
          options: [
            { id: "GreaterThanThreshold", label: "> Threshold" },
            { id: "GreaterThanOrEqualToThreshold", label: ">= Threshold" },
            { id: "LessThanThreshold", label: "< Threshold" },
            { id: "LessThanOrEqualToThreshold", label: "<= Threshold" },
          ],
          defaultValue: "GreaterThanThreshold",
        },
        {
          key: "threshold",
          label: "Threshold",
          kind: "number",
          required: true,
          defaultValue: "80",
        },
        {
          key: "period",
          label: "Period (seconds)",
          kind: "number",
          required: true,
          defaultValue: "300",
          minValue: 10,
        },
        {
          key: "evaluationPeriods",
          label: "Evaluation Periods",
          kind: "number",
          required: true,
          defaultValue: "1",
          minValue: 1,
        },
        {
          key: "statistic",
          label: "Statistic",
          kind: "select",
          required: true,
          options: [
            { id: "Average", label: "Average" },
            { id: "Sum", label: "Sum" },
            { id: "Minimum", label: "Minimum" },
            { id: "Maximum", label: "Maximum" },
            { id: "SampleCount", label: "Sample Count" },
          ],
          defaultValue: "Average",
        },
      ],
    };
  }
  if (typeId === "acm-certificate") {
    return {
      fields: [
        {
          key: "domainName",
          label: "Domain Name",
          kind: "text",
          required: true,
          description: "e.g. example.com or *.example.com",
        },
        {
          key: "validationMethod",
          label: "Validation Method",
          kind: "select",
          required: true,
          options: [
            { id: "DNS", label: "DNS" },
            { id: "EMAIL", label: "Email" },
          ],
          defaultValue: "DNS",
        },
      ],
    };
  }
  if (typeId === "iam-role") {
    const [awsManaged, customerManaged] = await Promise.all([
      ctx.listAllIAMPolicies("AWS").catch(() => []),
      ctx.listAllIAMPolicies("Local").catch(() => []),
    ]);
    const policies = [
      ...ctx.policiesToOptions(awsManaged, "AWS Managed"),
      ...ctx.policiesToOptions(customerManaged, "Customer Managed"),
    ];
    return {
      fields: [
        { key: "roleName", label: "Role Name", kind: "text", required: true },
        { key: "description", label: "Description", kind: "text", required: false },
        {
          key: "assumeRolePolicyDocument",
          label: "Assume Role Policy (JSON)",
          kind: "text",
          required: false,
          multiline: true,
          description: "Trust policy JSON (defaults to EC2 assume role)",
          defaultValue:
            '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"ec2.amazonaws.com"},"Action":"sts:AssumeRole"}]}',
        },
        {
          key: "attachedPolicies",
          label: "Attached Policies",
          kind: "policy-picker",
          required: false,
          description: "Managed IAM policies to attach to this role",
          policies,
        },
      ],
    };
  }
  if (typeId === "iam-user") {
    const [awsManaged, customerManaged] = await Promise.all([
      ctx.listAllIAMPolicies("AWS").catch(() => []),
      ctx.listAllIAMPolicies("Local").catch(() => []),
    ]);
    const policies = [
      ...ctx.policiesToOptions(awsManaged, "AWS Managed"),
      ...ctx.policiesToOptions(customerManaged, "Customer Managed"),
    ];
    return {
      fields: [
        { key: "userName", label: "User Name", kind: "text", required: true },
        {
          key: "attachedPolicies",
          label: "Attached Policies",
          kind: "policy-picker",
          required: false,
          description: "Managed IAM policies to attach to this user",
          policies,
        },
      ],
    };
  }
  if (typeId === "step-function") {
    return {
      fields: [
        { key: "name", label: "Name", kind: "text", required: true },
        {
          key: "definition",
          label: "Definition (JSON)",
          kind: "text",
          required: true,
          description: "State machine definition in ASL JSON",
        },
        {
          key: "type",
          label: "Type",
          kind: "select",
          required: true,
          options: [
            { id: "STANDARD", label: "Standard" },
            { id: "EXPRESS", label: "Express" },
          ],
          defaultValue: "STANDARD",
        },
        {
          key: "roleArn",
          label: "IAM Role ARN",
          kind: "text",
          required: true,
          description: "IAM role ARN for the state machine",
        },
      ],
    };
  }
  if (typeId === "eventbridge-rule") {
    return {
      fields: [
        { key: "name", label: "Rule Name", kind: "text", required: true },
        {
          key: "scheduleExpression",
          label: "Schedule Expression",
          kind: "text",
          required: false,
          description: "e.g. rate(5 minutes) or cron(0 12 * * ? *)",
        },
        {
          key: "eventPattern",
          label: "Event Pattern (JSON)",
          kind: "text",
          required: false,
          description: "JSON event pattern (provide either schedule or pattern)",
        },
        { key: "description", label: "Description", kind: "text", required: false },
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
  if (typeId === "apprunner-service") {
    return {
      fields: [
        { key: "serviceName", label: "Service Name", kind: "text", required: true },
        {
          key: "imageUri",
          label: "Container Image URI",
          kind: "text",
          required: true,
          description: "e.g. public.ecr.aws/nginx/nginx:latest",
        },
        {
          key: "port",
          label: "Port",
          kind: "number",
          required: true,
          defaultValue: "8080",
          minValue: 1,
          maxValue: 65535,
        },
        {
          key: "cpu",
          label: "CPU",
          kind: "select",
          required: true,
          options: [
            { id: "256", label: "0.25 vCPU" },
            { id: "512", label: "0.5 vCPU" },
            { id: "1024", label: "1 vCPU" },
            { id: "2048", label: "2 vCPU" },
            { id: "4096", label: "4 vCPU" },
          ],
          defaultValue: "1024",
        },
        {
          key: "memory",
          label: "Memory",
          kind: "select",
          required: true,
          options: [
            { id: "512", label: "0.5 GB" },
            { id: "1024", label: "1 GB" },
            { id: "2048", label: "2 GB" },
            { id: "3072", label: "3 GB" },
            { id: "4096", label: "4 GB" },
          ],
          defaultValue: "2048",
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
  if (typeId === "cloudformation-stack") {
    return {
      fields: [
        { key: "stackName", label: "Stack Name", kind: "text", required: true },
        {
          key: "templateBody",
          label: "Template Body (JSON/YAML)",
          kind: "text",
          required: true,
          description: "CloudFormation template",
        },
      ],
    };
  }
  if (typeId === "codebuild-project") {
    return {
      fields: [
        { key: "name", label: "Project Name", kind: "text", required: true },
        {
          key: "sourceType",
          label: "Source Type",
          kind: "select",
          required: true,
          options: [
            { id: "CODECOMMIT", label: "CodeCommit" },
            { id: "GITHUB", label: "GitHub" },
            { id: "S3", label: "S3" },
            { id: "BITBUCKET", label: "Bitbucket" },
            { id: "NO_SOURCE", label: "No Source" },
          ],
          defaultValue: "NO_SOURCE",
        },
        {
          key: "sourceLocation",
          label: "Source Location",
          kind: "text",
          required: false,
          description: "Repository URL or S3 path",
        },
        {
          key: "image",
          label: "Build Image",
          kind: "text",
          required: true,
          defaultValue: "aws/codebuild/amazonlinux2-x86_64-standard:5.0",
          description: "Docker image for the build environment",
        },
        {
          key: "computeType",
          label: "Compute Type",
          kind: "select",
          required: true,
          options: [
            { id: "BUILD_GENERAL1_SMALL", label: "Small (3 GB, 2 vCPU)" },
            { id: "BUILD_GENERAL1_MEDIUM", label: "Medium (7 GB, 4 vCPU)" },
            { id: "BUILD_GENERAL1_LARGE", label: "Large (15 GB, 8 vCPU)" },
          ],
          defaultValue: "BUILD_GENERAL1_SMALL",
        },
        {
          key: "serviceRole",
          label: "Service Role ARN",
          kind: "text",
          required: true,
          description: "IAM role ARN for CodeBuild",
        },
      ],
    };
  }
  if (typeId === "mq-broker") {
    return {
      fields: [
        { key: "brokerName", label: "Broker Name", kind: "text", required: true },
        {
          key: "engineType",
          label: "Engine",
          kind: "select",
          required: true,
          options: [
            { id: "ACTIVEMQ", label: "ActiveMQ" },
            { id: "RABBITMQ", label: "RabbitMQ" },
          ],
          defaultValue: "RABBITMQ",
        },
        {
          key: "hostInstanceType",
          label: "Instance Type",
          kind: "select",
          required: true,
          options: [
            { id: "mq.t3.micro", label: "mq.t3.micro" },
            { id: "mq.m5.large", label: "mq.m5.large" },
            { id: "mq.m5.xlarge", label: "mq.m5.xlarge" },
          ],
          defaultValue: "mq.t3.micro",
        },
        {
          key: "deploymentMode",
          label: "Deployment Mode",
          kind: "select",
          required: true,
          options: [
            { id: "SINGLE_INSTANCE", label: "Single Instance" },
            { id: "ACTIVE_STANDBY_MULTI_AZ", label: "Active/Standby Multi-AZ" },
            { id: "CLUSTER_MULTI_AZ", label: "Cluster Multi-AZ" },
          ],
          defaultValue: "SINGLE_INSTANCE",
        },
        {
          key: "username",
          label: "Admin Username",
          kind: "text",
          required: true,
          defaultValue: "admin",
        },
        { key: "password", label: "Admin Password", kind: "text", required: true },
      ],
    };
  }
  if (typeId === "waf-web-acl") {
    return {
      fields: [
        { key: "name", label: "Name", kind: "text", required: true },
        {
          key: "scope",
          label: "Scope",
          kind: "select",
          required: true,
          options: [
            { id: "REGIONAL", label: "Regional" },
            { id: "CLOUDFRONT", label: "CloudFront" },
          ],
          defaultValue: "REGIONAL",
        },
        {
          key: "defaultAction",
          label: "Default Action",
          kind: "select",
          required: true,
          options: [
            { id: "ALLOW", label: "Allow" },
            { id: "BLOCK", label: "Block" },
          ],
          defaultValue: "ALLOW",
        },
        { key: "description", label: "Description", kind: "text", required: false },
      ],
    };
  }
  if (typeId === "cloudtrail-trail") {
    // Fetch S3 buckets for the bucket selector
    const bucketsData = await ctx
      .xmlGet<Record<string, unknown>>("s3", "/")
      .catch(() => ({}) as Record<string, unknown>);
    const bucketsContainer = bucketsData["Buckets"] as Record<string, unknown> | undefined;
    const bucketList = ensureArray(bucketsContainer?.["Bucket"]) as Record<string, unknown>[];
    const bucketOptions = bucketList.map((b) => ({
      id: String(b["Name"] ?? ""),
      label: String(b["Name"] ?? ""),
    }));
    return {
      fields: [
        { key: "name", label: "Trail Name", kind: "text", required: true },
        {
          key: "s3BucketName",
          label: "S3 Bucket",
          kind: "select",
          required: true,
          options: bucketOptions,
          description: "S3 bucket for log file delivery",
        },
        {
          key: "isMultiRegion",
          label: "Multi-Region",
          kind: "select",
          required: false,
          options: [
            { id: "true", label: "Yes" },
            { id: "false", label: "No" },
          ],
          defaultValue: "true",
        },
        {
          key: "includeGlobalServiceEvents",
          label: "Include Global Events",
          kind: "select",
          required: false,
          options: [
            { id: "true", label: "Yes" },
            { id: "false", label: "No" },
          ],
          defaultValue: "true",
        },
      ],
    };
  }
  if (typeId === "api-gateway") {
    return {
      fields: [
        { key: "name", label: "API Name", kind: "text", required: true },
        {
          key: "protocolType",
          label: "Protocol Type",
          kind: "select",
          required: true,
          options: [
            { id: "HTTP", label: "HTTP" },
            { id: "WEBSOCKET", label: "WebSocket" },
          ],
          defaultValue: "HTTP",
        },
        {
          key: "description",
          label: "Description",
          kind: "text",
          required: false,
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
  throw new Error(`AWS plugin: getCreateConfig not supported for type "${typeId}"`);
}

export async function awsCreateResource(
  ctx: AwsCreateContext,
  typeId: string,
  accountId: string,
  fields: Record<string, string>,
  parentResourceId?: string,
): Promise<ResourceInstance> {
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
  if (typeId === "s3-bucket") {
    const bucketName = fields["name"] ?? "";
    const host = `${bucketName}.s3.${ctx.creds.region}.amazonaws.com`;
    const url = `https://${host}/`;
    const bodyXml =
      ctx.creds.region === "us-east-1"
        ? ""
        : `<CreateBucketConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><LocationConstraint>${ctx.creds.region}</LocationConstraint></CreateBucketConfiguration>`;
    const headers = await signRequest({
      method: "PUT",
      url,
      headers: { Host: host },
      body: bodyXml,
      service: "s3",
      credentials: ctx.creds,
    });
    const res = await fetch(url, {
      method: "PUT",
      headers,
      ...(bodyXml ? { body: bodyXml } : {}),
    });
    if (!res.ok) throw new Error(`S3 CreateBucket failed: ${res.status} ${await res.text()}`);

    return {
      id: ctx.makeId(accountId, "s3-bucket", bucketName),
      pluginId: "aws",
      resourceTypeId: "s3-bucket",
      accountId,
      displayName: bucketName,
      fields: {
        name: bucketName,
        region: ctx.creds.region,
        creationDate: new Date().toISOString(),
      },
      resolvedOutputs: {
        bucketArn: `arn:aws:s3:::${bucketName}`,
        endpoint: `https://${bucketName}.s3.${ctx.creds.region}.amazonaws.com`,
      },
      secretStates: [],
      externalId: bucketName,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }
  if (typeId === "vpc") {
    const data = await ctx.ec2<Record<string, unknown>>("CreateVpc", {
      CidrBlock: fields["cidrBlock"] ?? "10.0.0.0/16",
    });
    const vpc = (data["vpc"] ?? data) as Record<string, unknown>;
    const vpcId = String(vpc["vpcId"] ?? "");
    // Tag with name
    if (fields["name"]) {
      await ctx.ec2("CreateTags", {
        "ResourceId.1": vpcId,
        "Tag.1.Key": "Name",
        "Tag.1.Value": fields["name"],
      });
    }
    return {
      id: ctx.makeId(accountId, "vpc", vpcId),
      pluginId: "aws",
      resourceTypeId: "vpc",
      accountId,
      displayName: fields["name"] || vpcId,
      fields: {
        vpcId,
        name: fields["name"] ?? "",
        cidrBlock: fields["cidrBlock"] ?? "10.0.0.0/16",
        state: "available",
        isDefault: false,
        tenancy: "default",
      },
      resolvedOutputs: {},
      secretStates: [],
      externalId: vpcId,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }
  if (typeId === "security-group") {
    const params: Record<string, string> = {
      GroupName: fields["groupName"] ?? "",
      GroupDescription: fields["description"] ?? "",
    };
    if (fields["vpcId"]) params["VpcId"] = fields["vpcId"];
    const data = await ctx.ec2<Record<string, unknown>>("CreateSecurityGroup", params);
    const groupId = String(data["groupId"] ?? "");
    return {
      id: ctx.makeId(accountId, "security-group", groupId),
      pluginId: "aws",
      resourceTypeId: "security-group",
      accountId,
      displayName: fields["groupName"] ?? groupId,
      fields: {
        groupId,
        groupName: fields["groupName"] ?? "",
        description: fields["description"] ?? "",
        vpcId: fields["vpcId"] ?? "",
        inboundRuleCount: 0,
        outboundRuleCount: 1,
      },
      resolvedOutputs: { groupId },
      secretStates: [],
      externalId: groupId,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }
  if (typeId === "sqs-queue") {
    const queueName =
      fields["fifo"] === "true"
        ? (fields["queueName"] ?? "").replace(/\.fifo$/, "") + ".fifo"
        : (fields["queueName"] ?? "");
    const body: Record<string, unknown> = { QueueName: queueName };
    if (fields["fifo"] === "true") {
      body["Attributes"] = { FifoQueue: "true" };
    }
    const data = await ctx.json<{ QueueUrl?: string }>("sqs", "AmazonSQS.CreateQueue", body);
    const queueUrl = data.QueueUrl ?? "";
    return {
      id: ctx.makeId(accountId, "sqs-queue", queueName),
      pluginId: "aws",
      resourceTypeId: "sqs-queue",
      accountId,
      displayName: queueName,
      fields: {
        queueName,
        queueUrl,
        approximateMessages: 0,
        approximateMessagesDelayed: 0,
        approximateMessagesNotVisible: 0,
        isFifo: queueName.endsWith(".fifo"),
      },
      resolvedOutputs: { queueArn: "" },
      secretStates: [],
      externalId: queueName,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }
  if (typeId === "sns-topic") {
    const topicName =
      fields["fifo"] === "true"
        ? (fields["topicName"] ?? "").replace(/\.fifo$/, "") + ".fifo"
        : (fields["topicName"] ?? "");
    const body: Record<string, unknown> = { Name: topicName };
    if (fields["fifo"] === "true") {
      body["Attributes"] = { FifoTopic: "true" };
    }
    const data = await ctx.json<{ TopicArn?: string }>("sns", "SNS.CreateTopic", body);
    const topicArn = data.TopicArn ?? "";
    return {
      id: ctx.makeId(accountId, "sns-topic", topicName),
      pluginId: "aws",
      resourceTypeId: "sns-topic",
      accountId,
      displayName: topicName,
      fields: {
        topicName,
        topicArn,
        subscriptionCount: 0,
        isFifo: topicName.endsWith(".fifo"),
      },
      resolvedOutputs: { topicArn },
      secretStates: [],
      externalId: topicName,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }
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
  if (typeId === "ecr-repository") {
    const repoName = fields["repositoryName"] ?? "";
    const data = await ctx.json<{ repository?: Record<string, unknown> }>(
      "ecr",
      "AmazonEC2ContainerRegistry_V20150921.CreateRepository",
      {
        repositoryName: repoName,
        imageTagMutability: fields["imageTagMutability"] ?? "MUTABLE",
        imageScanningConfiguration: {
          scanOnPush: fields["scanOnPush"] === "true",
        },
      },
    );
    const repo = data.repository ?? {};
    return {
      id: ctx.makeId(accountId, "ecr-repository", repoName),
      pluginId: "aws",
      resourceTypeId: "ecr-repository",
      accountId,
      displayName: repoName,
      fields: {
        repositoryName: repoName,
        registryId: String(repo["registryId"] ?? ""),
        imageCount: 0,
        imageScanOnPush: fields["scanOnPush"] === "true",
        encryptionType: "AES256",
      },
      resolvedOutputs: {
        repositoryUri: String(repo["repositoryUri"] ?? ""),
        repositoryArn: String(repo["repositoryArn"] ?? ""),
      },
      secretStates: [],
      externalId: repoName,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }
  if (typeId === "efs-file-system") {
    const host = ctx.hostForService("elasticfilesystem");
    const url = `https://${host}/2015-02-01/file-systems`;
    const bodyObj: Record<string, unknown> = {
      CreationToken: `iw-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      PerformanceMode: fields["performanceMode"] ?? "generalPurpose",
      ThroughputMode: fields["throughputMode"] ?? "elastic",
      Encrypted: fields["encrypted"] !== "false",
    };
    if (fields["name"]) {
      bodyObj["Tags"] = [{ Key: "Name", Value: fields["name"] }];
    }
    const bodyStr = JSON.stringify(bodyObj);
    const headers = await signRequest({
      method: "POST",
      url,
      headers: { Host: host, "Content-Type": "application/json" },
      body: bodyStr,
      service: "elasticfilesystem",
      credentials: ctx.creds,
    });
    const res = await fetch(url, { method: "POST", headers, body: bodyStr });
    if (!res.ok) throw new Error(`EFS CreateFileSystem failed: ${res.status} ${await res.text()}`);
    const fs = (await res.json()) as Record<string, unknown>;
    const fsId = String(fs["FileSystemId"] ?? "");
    return {
      id: ctx.makeId(accountId, "efs-file-system", fsId),
      pluginId: "aws",
      resourceTypeId: "efs-file-system",
      accountId,
      displayName: fields["name"] || fsId,
      fields: {
        name: fields["name"] ?? "",
        fileSystemId: fsId,
        lifeCycleState: String(fs["LifeCycleState"] ?? "creating"),
        performanceMode: fields["performanceMode"] ?? "generalPurpose",
        throughputMode: fields["throughputMode"] ?? "elastic",
        sizeInBytes: 0,
        encrypted: fields["encrypted"] !== "false",
        numberOfMountTargets: 0,
      },
      resolvedOutputs: {
        fileSystemArn: String(fs["FileSystemArn"] ?? ""),
        fileSystemId: fsId,
      },
      secretStates: [],
      externalId: fsId,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }
  if (typeId === "route53-hosted-zone") {
    const domainName = fields["name"] ?? "";
    const host = ctx.hostForService("route53");
    const url = `https://${host}/2013-04-01/hostedzone`;
    const bodyXml = [
      `<?xml version="1.0" encoding="UTF-8"?>`,
      `<CreateHostedZoneRequest xmlns="https://route53.amazonaws.com/doc/2013-04-01/">`,
      `<Name>${domainName}</Name>`,
      `<CallerReference>${Date.now()}</CallerReference>`,
      fields["comment"]
        ? `<HostedZoneConfig><Comment>${fields["comment"]}</Comment></HostedZoneConfig>`
        : "",
      `</CreateHostedZoneRequest>`,
    ].join("");
    const headers = await signRequest({
      method: "POST",
      url,
      headers: { Host: host, "Content-Type": "application/xml" },
      body: bodyXml,
      service: "route53",
      credentials: ctx.creds,
    });
    const res = await fetch(url, { method: "POST", headers, body: bodyXml });
    if (!res.ok)
      throw new Error(`Route53 CreateHostedZone failed: ${res.status} ${await res.text()}`);
    const xml = await res.text();
    const parsed = parseXml(xml) as Record<string, unknown>;
    const hz = (parsed["HostedZone"] ?? {}) as Record<string, unknown>;
    const zoneId = String(hz["Id"] ?? "").replace("/hostedzone/", "");
    return {
      id: ctx.makeId(accountId, "route53-hosted-zone", zoneId),
      pluginId: "aws",
      resourceTypeId: "route53-hosted-zone",
      accountId,
      displayName: domainName,
      fields: {
        name: domainName,
        hostedZoneId: zoneId,
        recordCount: 0,
        isPrivate: false,
        comment: fields["comment"] ?? "",
      },
      resolvedOutputs: {
        hostedZoneId: zoneId,
        nameServers: "",
      },
      secretStates: [],
      externalId: zoneId,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }
  if (typeId === "cloudwatch-log-group") {
    const logGroupName = fields["logGroupName"] ?? "";
    const body: Record<string, unknown> = { logGroupName };
    await ctx.json<Record<string, unknown>>("logs", "Logs_20140328.CreateLogGroup", body);
    const retention = Number(fields["retentionInDays"] ?? "0");
    if (retention > 0) {
      await ctx.json<Record<string, unknown>>("logs", "Logs_20140328.PutRetentionPolicy", {
        logGroupName,
        retentionInDays: retention,
      });
    }
    return {
      id: ctx.makeId(accountId, "cloudwatch-log-group", logGroupName),
      pluginId: "aws",
      resourceTypeId: "cloudwatch-log-group",
      accountId,
      displayName: logGroupName,
      fields: {
        logGroupName,
        storedBytes: 0,
        retentionInDays: retention,
        metricFilterCount: 0,
        kmsKeyId: "",
      },
      resolvedOutputs: {
        logGroupArn: "",
      },
      secretStates: [],
      externalId: logGroupName,
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
  if (typeId === "secrets-manager-secret") {
    const name = fields["name"] ?? "";
    const data = await ctx.json<{ ARN?: string; Name?: string }>(
      "secretsmanager",
      "secretsmanager.CreateSecret",
      {
        Name: name,
        ...(fields["description"] ? { Description: fields["description"] } : {}),
        SecretString: fields["secretValue"] ?? "",
      },
    );
    return {
      id: ctx.makeId(accountId, "secrets-manager-secret", name),
      pluginId: "aws",
      resourceTypeId: "secrets-manager-secret",
      accountId,
      displayName: name,
      fields: {
        name,
        description: fields["description"] ?? "",
        lastAccessedDate: "",
        lastChangedDate: "",
        rotationEnabled: false,
      },
      resolvedOutputs: {
        secretArn: String(data.ARN ?? ""),
      },
      secretStates: [],
      externalId: name,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }
  if (typeId === "ssm-parameter") {
    const name = fields["name"] ?? "";
    await ctx.json<Record<string, unknown>>("ssm", "AmazonSSM.PutParameter", {
      Name: name,
      Type: fields["type"] ?? "String",
      Value: fields["value"] ?? "",
    });
    return {
      id: ctx.makeId(accountId, "ssm-parameter", name),
      pluginId: "aws",
      resourceTypeId: "ssm-parameter",
      accountId,
      displayName: name,
      fields: {
        name,
        type: fields["type"] ?? "String",
        version: 1,
        tier: "Standard",
        lastModifiedDate: new Date().toISOString(),
        dataType: "text",
      },
      resolvedOutputs: {
        parameterArn: `arn:aws:ssm:${ctx.creds.region}:${accountId}:parameter${name.startsWith("/") ? "" : "/"}${name}`,
        parameterValue: "",
      },
      secretStates: [],
      externalId: name,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }
  if (typeId === "kinesis-stream") {
    const streamName = fields["streamName"] ?? "";
    await ctx.json<Record<string, unknown>>("kinesis", "Kinesis_20131202.CreateStream", {
      StreamName: streamName,
      ShardCount: Number(fields["shardCount"] ?? "1"),
    });
    return {
      id: ctx.makeId(accountId, "kinesis-stream", streamName),
      pluginId: "aws",
      resourceTypeId: "kinesis-stream",
      accountId,
      displayName: streamName,
      fields: {
        streamName,
        status: "CREATING",
        shardCount: Number(fields["shardCount"] ?? "1"),
        retentionPeriodHours: 24,
        streamModeDetails: "PROVISIONED",
        encryptionType: "NONE",
      },
      resolvedOutputs: {
        streamArn: "",
      },
      secretStates: [],
      externalId: streamName,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }
  if (typeId === "glue-database") {
    const name = fields["name"] ?? "";
    await ctx.json<Record<string, unknown>>("glue", "AWSGlue.CreateDatabase", {
      DatabaseInput: {
        Name: name,
        ...(fields["description"] ? { Description: fields["description"] } : {}),
      },
    });
    return {
      id: ctx.makeId(accountId, "glue-database", name),
      pluginId: "aws",
      resourceTypeId: "glue-database",
      accountId,
      displayName: name,
      fields: {
        name,
        description: fields["description"] ?? "",
        locationUri: "",
        createTime: new Date().toISOString(),
        catalogId: accountId,
      },
      resolvedOutputs: {},
      secretStates: [],
      externalId: name,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }
  if (typeId === "internet-gateway") {
    const data = await ctx.ec2<Record<string, unknown>>("CreateInternetGateway");
    const igw = (data["internetGateway"] ?? data) as Record<string, unknown>;
    const igwId = String(igw["internetGatewayId"] ?? "");
    if (fields["name"]) {
      await ctx.ec2("CreateTags", {
        "ResourceId.1": igwId,
        "Tag.1.Key": "Name",
        "Tag.1.Value": fields["name"],
      });
    }
    return {
      id: ctx.makeId(accountId, "internet-gateway", igwId),
      pluginId: "aws",
      resourceTypeId: "internet-gateway",
      accountId,
      displayName: igwId,
      fields: {
        internetGatewayId: igwId,
        vpcId: "",
        state: "detached",
      },
      resolvedOutputs: {},
      secretStates: [],
      externalId: igwId,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }
  if (typeId === "subnet") {
    const parentVpcId = parentResourceId ? parentResourceId.split(":").slice(2).join(":") : "";
    const vpcId = fields["vpcId"] || parentVpcId;
    const params: Record<string, string> = {
      VpcId: vpcId,
      CidrBlock: fields["cidrBlock"] ?? "",
      AvailabilityZone: fields["availabilityZone"] ?? "",
    };
    const data = await ctx.ec2<Record<string, unknown>>("CreateSubnet", params);
    const sub = (data["subnet"] ?? data) as Record<string, unknown>;
    const subnetId = String(sub["subnetId"] ?? "");
    if (fields["name"]) {
      await ctx.ec2("CreateTags", {
        "ResourceId.1": subnetId,
        "Tag.1.Key": "Name",
        "Tag.1.Value": fields["name"],
      });
    }
    return {
      id: ctx.makeId(accountId, "subnet", subnetId),
      pluginId: "aws",
      resourceTypeId: "subnet",
      accountId,
      displayName: fields["name"] || subnetId,
      fields: {
        subnetId,
        name: fields["name"] ?? "",
        vpcId,
        cidrBlock: fields["cidrBlock"] ?? "",
        availabilityZone: fields["availabilityZone"] ?? "",
        state: "available",
        availableIps: 0,
        mapPublicIp: false,
      },
      resolvedOutputs: {
        subnetArn: String(sub["subnetArn"] ?? ""),
      },
      secretStates: [],
      externalId: subnetId,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }
  if (typeId === "nat-gateway") {
    const data = await ctx.ec2<Record<string, unknown>>("CreateNatGateway", {
      SubnetId: fields["subnetId"] ?? "",
      AllocationId: fields["allocationId"] ?? "",
    });
    const nat = (data["natGateway"] ?? data) as Record<string, unknown>;
    const natGatewayId = String(nat["natGatewayId"] ?? "");
    return {
      id: ctx.makeId(accountId, "nat-gateway", natGatewayId),
      pluginId: "aws",
      resourceTypeId: "nat-gateway",
      accountId,
      displayName: natGatewayId,
      fields: {
        natGatewayId,
        state: "pending",
        subnetId: fields["subnetId"] ?? "",
        vpcId: "",
        connectivityType: "public",
        publicIp: "",
        privateIp: "",
      },
      resolvedOutputs: { natGatewayId },
      secretStates: [],
      externalId: natGatewayId,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }
  if (typeId === "target-group") {
    // Target groups tie to a VPC. When created from an ALB's detail page, the
    // vpcId field is hidden — look up the parent ALB to read its vpcId since
    // the ALB's externalId is just its name, not the VPC.
    let vpcId = fields["vpcId"] ?? "";
    if (!vpcId && parentResourceId) {
      const alb = await ctx.getResource("alb", parentResourceId, accountId);
      vpcId = String(alb.fields["vpcId"] ?? "");
    }
    const params: Record<string, string> = {
      Name: fields["name"] ?? "",
      Protocol: fields["protocol"] ?? "HTTP",
      Port: fields["port"] ?? "80",
      VpcId: vpcId,
      TargetType: fields["targetType"] ?? "instance",
    };
    const data = await ctx.ec2Query<Record<string, unknown>>(
      "elasticloadbalancing",
      "CreateTargetGroup",
      "2015-12-01",
      params,
    );
    const tgs = ensureArray(
      (data["TargetGroups"] as Record<string, unknown> | undefined)?.["member"],
    ) as Record<string, unknown>[];
    const tg = tgs[0] ?? {};
    const name = fields["name"] ?? "";
    return {
      id: ctx.makeId(accountId, "target-group", name),
      pluginId: "aws",
      resourceTypeId: "target-group",
      accountId,
      displayName: name,
      fields: {
        name,
        protocol: fields["protocol"] ?? "HTTP",
        port: Number(fields["port"] ?? 80),
        targetType: fields["targetType"] ?? "instance",
        vpcId,
        healthCheckProtocol: String(tg["HealthCheckProtocol"] ?? ""),
        healthCheckPath: String(tg["HealthCheckPath"] ?? ""),
        healthyThreshold: Number(tg["HealthyThresholdCount"] ?? 0),
      },
      resolvedOutputs: {
        targetGroupArn: String(tg["TargetGroupArn"] ?? ""),
      },
      secretStates: [],
      externalId: name,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }
  if (typeId === "alb") {
    const subnets = (fields["subnets"] ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const params: Record<string, string> = {
      Name: fields["name"] ?? "",
      Scheme: fields["scheme"] ?? "internet-facing",
    };
    subnets.forEach((s, i) => {
      params[`Subnets.member.${i + 1}`] = s;
    });
    const data = await ctx.ec2Query<Record<string, unknown>>(
      "elasticloadbalancing",
      "CreateLoadBalancer",
      "2015-12-01",
      params,
    );
    const lbs = ensureArray(
      (data["LoadBalancers"] as Record<string, unknown> | undefined)?.["member"],
    ) as Record<string, unknown>[];
    const lb = lbs[0] ?? {};
    const name = fields["name"] ?? "";
    return {
      id: ctx.makeId(accountId, "alb", name),
      pluginId: "aws",
      resourceTypeId: "alb",
      accountId,
      displayName: name,
      fields: {
        name,
        type: String(lb["Type"] ?? "application"),
        state: "provisioning",
        scheme: fields["scheme"] ?? "internet-facing",
        vpcId: String(lb["VpcId"] ?? ""),
        availabilityZones: "",
        ipAddressType: String(lb["IpAddressType"] ?? ""),
      },
      resolvedOutputs: {
        dnsName: String(lb["DNSName"] ?? ""),
        loadBalancerArn: String(lb["LoadBalancerArn"] ?? ""),
        canonicalHostedZoneId: String(lb["CanonicalHostedZoneId"] ?? ""),
      },
      secretStates: [],
      externalId: name,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }
  if (typeId === "route53-record-set") {
    const parentHostedZoneId = parentResourceId
      ? parentResourceId.split(":").slice(2).join(":")
      : "";
    const hostedZoneId = fields["hostedZoneId"] || parentHostedZoneId;
    const recordName = fields["name"] ?? "";
    const recordType = fields["type"] ?? "A";
    const ttl = fields["ttl"] ?? "300";
    const value = fields["value"] ?? "";
    const host = ctx.hostForService("route53");
    const url = `https://${host}/2013-04-01/hostedzone/${hostedZoneId}/rrset`;
    const bodyXml = [
      `<?xml version="1.0" encoding="UTF-8"?>`,
      `<ChangeResourceRecordSetsRequest xmlns="https://route53.amazonaws.com/doc/2013-04-01/">`,
      `<ChangeBatch><Changes><Change>`,
      `<Action>CREATE</Action>`,
      `<ResourceRecordSet>`,
      `<Name>${recordName}</Name>`,
      `<Type>${recordType}</Type>`,
      `<TTL>${ttl}</TTL>`,
      `<ResourceRecords><ResourceRecord><Value>${value}</Value></ResourceRecord></ResourceRecords>`,
      `</ResourceRecordSet>`,
      `</Change></Changes></ChangeBatch>`,
      `</ChangeResourceRecordSetsRequest>`,
    ].join("");
    const headers = await signRequest({
      method: "POST",
      url,
      headers: { Host: host, "Content-Type": "application/xml" },
      body: bodyXml,
      service: "route53",
      credentials: ctx.creds,
    });
    const res = await fetch(url, { method: "POST", headers, body: bodyXml });
    if (!res.ok)
      throw new Error(`Route53 ChangeResourceRecordSets failed: ${res.status} ${await res.text()}`);
    const recordId = `${hostedZoneId}:${recordName}:${recordType}`;
    return {
      id: ctx.makeId(accountId, "route53-record-set", recordId),
      pluginId: "aws",
      resourceTypeId: "route53-record-set",
      accountId,
      displayName: `${recordName} (${recordType})`,
      fields: {
        name: recordName,
        type: recordType,
        ttl: Number(ttl),
        values: value,
        hostedZoneId,
      },
      resolvedOutputs: {},
      secretStates: [],
      externalId: recordId,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }
  if (typeId === "cloudwatch-alarm") {
    const alarmName = fields["alarmName"] ?? "";
    await ctx.json<Record<string, unknown>>(
      "monitoring",
      "GraniteServiceVersion20100801.PutMetricAlarm",
      {
        AlarmName: alarmName,
        Namespace: fields["namespace"] ?? "",
        MetricName: fields["metricName"] ?? "",
        ComparisonOperator: fields["comparisonOperator"] ?? "GreaterThanThreshold",
        Threshold: Number(fields["threshold"] ?? "80"),
        Period: Number(fields["period"] ?? "300"),
        EvaluationPeriods: Number(fields["evaluationPeriods"] ?? "1"),
        Statistic: fields["statistic"] ?? "Average",
      },
    );
    return {
      id: ctx.makeId(accountId, "cloudwatch-alarm", alarmName),
      pluginId: "aws",
      resourceTypeId: "cloudwatch-alarm",
      accountId,
      displayName: alarmName,
      fields: {
        alarmName,
        state: "INSUFFICIENT_DATA",
        metricName: fields["metricName"] ?? "",
        namespace: fields["namespace"] ?? "",
        comparisonOperator: fields["comparisonOperator"] ?? "GreaterThanThreshold",
        threshold: Number(fields["threshold"] ?? "80"),
        period: Number(fields["period"] ?? "300"),
        actionsEnabled: true,
      },
      resolvedOutputs: {
        alarmArn: "",
      },
      secretStates: [],
      externalId: alarmName,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }
  if (typeId === "acm-certificate") {
    const domainName = fields["domainName"] ?? "";
    const data = await ctx.json<{ CertificateArn?: string }>(
      "acm",
      "CertificateManager.RequestCertificate",
      {
        DomainName: domainName,
        ValidationMethod: fields["validationMethod"] ?? "DNS",
      },
    );
    const arn = data.CertificateArn ?? "";
    return {
      id: ctx.makeId(accountId, "acm-certificate", arn),
      pluginId: "aws",
      resourceTypeId: "acm-certificate",
      accountId,
      displayName: domainName,
      fields: {
        domainName,
        status: "PENDING_VALIDATION",
        type: "AMAZON_ISSUED",
        issuer: "",
        notBefore: "",
        notAfter: "",
        keyAlgorithm: "RSA_2048",
        subjectAlternativeNames: domainName,
        inUseBy: 0,
      },
      resolvedOutputs: { certificateArn: arn },
      secretStates: [],
      externalId: arn,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }
  if (typeId === "iam-role") {
    const roleName = fields["roleName"] ?? "";
    const defaultPolicy =
      '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"ec2.amazonaws.com"},"Action":"sts:AssumeRole"}]}';
    const createParams: Record<string, string> = {
      RoleName: roleName,
      AssumeRolePolicyDocument: fields["assumeRolePolicyDocument"] || defaultPolicy,
    };
    if (fields["description"]) createParams["Description"] = fields["description"];
    const data = await ctx.queryPost<Record<string, unknown>>(
      "iam",
      "CreateRole",
      "2010-05-08",
      createParams,
    );
    const createResult = data["CreateRoleResult"] as Record<string, unknown> | undefined;
    const role = (createResult?.["Role"] as Record<string, unknown>) ?? {};
    const policyArns = parsePolicyArns(fields["attachedPolicies"]);
    if (policyArns.length > 0) {
      await Promise.all(
        policyArns.map((arn) =>
          ctx.queryPost<Record<string, unknown>>("iam", "AttachRolePolicy", "2010-05-08", {
            RoleName: roleName,
            PolicyArn: arn,
          }),
        ),
      );
    }
    return {
      id: ctx.makeId(accountId, "iam-role", roleName),
      pluginId: "aws",
      resourceTypeId: "iam-role",
      accountId,
      displayName: roleName,
      fields: {
        roleName,
        roleId: String(role["RoleId"] ?? ""),
        path: String(role["Path"] ?? "/"),
        createDate: new Date().toISOString(),
        description: fields["description"] ?? "",
        maxSessionDuration: 3600,
      },
      resolvedOutputs: {
        roleArn: String(role["Arn"] ?? ""),
      },
      secretStates: [],
      externalId: roleName,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }
  if (typeId === "iam-user") {
    const userName = fields["userName"] ?? "";
    const data = await ctx.queryPost<Record<string, unknown>>("iam", "CreateUser", "2010-05-08", {
      UserName: userName,
    });
    const createResult = data["CreateUserResult"] as Record<string, unknown> | undefined;
    const user = (createResult?.["User"] as Record<string, unknown>) ?? {};
    const policyArns = parsePolicyArns(fields["attachedPolicies"]);
    if (policyArns.length > 0) {
      await Promise.all(
        policyArns.map((arn) =>
          ctx.queryPost<Record<string, unknown>>("iam", "AttachUserPolicy", "2010-05-08", {
            UserName: userName,
            PolicyArn: arn,
          }),
        ),
      );
    }
    return {
      id: ctx.makeId(accountId, "iam-user", userName),
      pluginId: "aws",
      resourceTypeId: "iam-user",
      accountId,
      displayName: userName,
      fields: {
        userName,
        userId: String(user["UserId"] ?? ""),
        path: String(user["Path"] ?? "/"),
        createDate: new Date().toISOString(),
        passwordLastUsed: "",
      },
      resolvedOutputs: {
        userArn: String(user["Arn"] ?? ""),
      },
      secretStates: [],
      externalId: userName,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }
  if (typeId === "step-function") {
    const name = fields["name"] ?? "";
    const data = await ctx.json<{ stateMachineArn?: string }>(
      "states",
      "AWSStepFunctions.CreateStateMachine",
      {
        name,
        definition: fields["definition"] ?? "{}",
        type: fields["type"] ?? "STANDARD",
        roleArn: fields["roleArn"] ?? "",
      },
    );
    const arn = data.stateMachineArn ?? "";
    return {
      id: ctx.makeId(accountId, "step-function", name),
      pluginId: "aws",
      resourceTypeId: "step-function",
      accountId,
      displayName: name,
      fields: {
        name,
        status: "ACTIVE",
        type: fields["type"] ?? "STANDARD",
        creationDate: new Date().toISOString(),
      },
      resolvedOutputs: { stateMachineArn: arn },
      secretStates: [],
      externalId: name,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }
  if (typeId === "eventbridge-rule") {
    const name = fields["name"] ?? "";
    const body: Record<string, unknown> = { Name: name };
    if (fields["scheduleExpression"]) body["ScheduleExpression"] = fields["scheduleExpression"];
    if (fields["eventPattern"]) body["EventPattern"] = fields["eventPattern"];
    if (fields["description"]) body["Description"] = fields["description"];
    const data = await ctx.json<{ RuleArn?: string }>("events", "AWSEvents.PutRule", body);
    const ruleArn = data.RuleArn ?? "";
    return {
      id: ctx.makeId(accountId, "eventbridge-rule", name),
      pluginId: "aws",
      resourceTypeId: "eventbridge-rule",
      accountId,
      displayName: name,
      fields: {
        name,
        state: "ENABLED",
        eventBusName: "default",
        scheduleExpression: fields["scheduleExpression"] ?? "",
        description: fields["description"] ?? "",
      },
      resolvedOutputs: { ruleArn },
      secretStates: [],
      externalId: name,
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
  if (typeId === "apprunner-service") {
    const serviceName = fields["serviceName"] ?? "";
    const data = await ctx.json<{ Service?: Record<string, unknown> }>(
      "apprunner",
      "AppRunner.CreateService",
      {
        ServiceName: serviceName,
        SourceConfiguration: {
          ImageRepository: {
            ImageIdentifier: fields["imageUri"] ?? "",
            ImageRepositoryType: "ECR_PUBLIC",
            ImageConfiguration: {
              Port: fields["port"] ?? "8080",
            },
          },
          AutoDeploymentsEnabled: false,
        },
        InstanceConfiguration: {
          Cpu: fields["cpu"] ?? "1024",
          Memory: fields["memory"] ?? "2048",
        },
      },
    );
    const svc = data.Service ?? {};
    return {
      id: ctx.makeId(accountId, "apprunner-service", serviceName),
      pluginId: "aws",
      resourceTypeId: "apprunner-service",
      accountId,
      displayName: serviceName,
      fields: {
        serviceName,
        status: String(svc["Status"] ?? "OPERATION_IN_PROGRESS"),
        serviceId: String(svc["ServiceId"] ?? ""),
        sourceType: "IMAGE",
        cpu: fields["cpu"] ?? "1024",
        memory: fields["memory"] ?? "2048",
      },
      resolvedOutputs: {
        serviceUrl: String(svc["ServiceUrl"] ?? ""),
        serviceArn: String(svc["ServiceArn"] ?? ""),
      },
      secretStates: [],
      externalId: serviceName,
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
  if (typeId === "cloudformation-stack") {
    const stackName = fields["stackName"] ?? "";
    await ctx.json<Record<string, unknown>>("cloudformation", "CloudFormation.CreateStack", {
      StackName: stackName,
      TemplateBody: fields["templateBody"] ?? "",
    });
    return {
      id: ctx.makeId(accountId, "cloudformation-stack", stackName),
      pluginId: "aws",
      resourceTypeId: "cloudformation-stack",
      accountId,
      displayName: stackName,
      fields: {
        stackName,
        stackId: "",
        status: "CREATE_IN_PROGRESS",
        description: "",
        driftStatus: "",
        enableTerminationProtection: false,
      },
      resolvedOutputs: {
        stackArn: "",
      },
      secretStates: [],
      externalId: stackName,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }
  if (typeId === "codebuild-project") {
    const name = fields["name"] ?? "";
    const data = await ctx.json<{ project?: Record<string, unknown> }>(
      "codebuild",
      "CodeBuild_20161006.CreateProject",
      {
        name,
        source: {
          type: fields["sourceType"] ?? "NO_SOURCE",
          ...(fields["sourceLocation"] ? { location: fields["sourceLocation"] } : {}),
          ...(fields["sourceType"] === "NO_SOURCE"
            ? {
                buildspec: "version: 0.2\nphases:\n  build:\n    commands:\n      - echo Hello",
              }
            : {}),
        },
        artifacts: { type: "NO_ARTIFACTS" },
        environment: {
          type: "LINUX_CONTAINER",
          image: fields["image"] ?? "aws/codebuild/amazonlinux2-x86_64-standard:5.0",
          computeType: fields["computeType"] ?? "BUILD_GENERAL1_SMALL",
        },
        serviceRole: fields["serviceRole"] ?? "",
      },
    );
    const p = data.project ?? {};
    return {
      id: ctx.makeId(accountId, "codebuild-project", name),
      pluginId: "aws",
      resourceTypeId: "codebuild-project",
      accountId,
      displayName: name,
      fields: {
        name,
        description: "",
        sourceType: fields["sourceType"] ?? "NO_SOURCE",
        environment: fields["image"] ?? "aws/codebuild/amazonlinux2-x86_64-standard:5.0",
        computeType: fields["computeType"] ?? "BUILD_GENERAL1_SMALL",
        lastBuildStatus: "",
        badge: false,
      },
      resolvedOutputs: {
        projectArn: String(p["arn"] ?? ""),
      },
      secretStates: [],
      externalId: name,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }
  if (typeId === "mq-broker") {
    const brokerName = fields["brokerName"] ?? "";
    const host = ctx.hostForService("mq");
    const url = `https://${host}/v1/brokers`;
    const bodyObj = {
      BrokerName: brokerName,
      EngineType: fields["engineType"] ?? "RABBITMQ",
      EngineVersion: fields["engineType"] === "ACTIVEMQ" ? "5.17.6" : "3.11.20",
      HostInstanceType: fields["hostInstanceType"] ?? "mq.t3.micro",
      DeploymentMode: fields["deploymentMode"] ?? "SINGLE_INSTANCE",
      PubliclyAccessible: false,
      Users: [
        {
          Username: fields["username"] ?? "admin",
          Password: fields["password"] ?? "",
        },
      ],
    };
    const bodyStr = JSON.stringify(bodyObj);
    const headers = await signRequest({
      method: "POST",
      url,
      headers: { Host: host, "Content-Type": "application/json" },
      body: bodyStr,
      service: "mq",
      credentials: ctx.creds,
    });
    const res = await fetch(url, { method: "POST", headers, body: bodyStr });
    if (!res.ok) throw new Error(`MQ CreateBroker failed: ${res.status} ${await res.text()}`);
    const result = (await res.json()) as Record<string, unknown>;
    const brokerId = String(result["BrokerId"] ?? "");
    return {
      id: ctx.makeId(accountId, "mq-broker", brokerId),
      pluginId: "aws",
      resourceTypeId: "mq-broker",
      accountId,
      displayName: brokerName,
      fields: {
        brokerName,
        brokerId,
        engineType: fields["engineType"] ?? "RABBITMQ",
        engineVersion: fields["engineType"] === "ACTIVEMQ" ? "5.17.6" : "3.11.20",
        hostInstanceType: fields["hostInstanceType"] ?? "mq.t3.micro",
        deploymentMode: fields["deploymentMode"] ?? "SINGLE_INSTANCE",
        status: "CREATION_IN_PROGRESS",
      },
      resolvedOutputs: {
        brokerArn: String(result["BrokerArn"] ?? ""),
        consoleUrl: "",
      },
      secretStates: [],
      externalId: brokerId,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }
  if (typeId === "waf-web-acl") {
    const name = fields["name"] ?? "";
    const scope = fields["scope"] ?? "REGIONAL";
    const defaultAction = fields["defaultAction"] === "BLOCK" ? { Block: {} } : { Allow: {} };
    const data = await ctx.json<{ Summary?: Record<string, unknown> }>(
      "wafv2",
      "AWSWAF_20190729.CreateWebACL",
      {
        Name: name,
        Scope: scope,
        DefaultAction: defaultAction,
        ...(fields["description"] ? { Description: fields["description"] } : {}),
        VisibilityConfig: {
          SampledRequestsEnabled: true,
          CloudWatchMetricsEnabled: true,
          MetricName: name,
        },
        Rules: [],
      },
    );
    const summary = data.Summary ?? {};
    return {
      id: ctx.makeId(accountId, "waf-web-acl", name),
      pluginId: "aws",
      resourceTypeId: "waf-web-acl",
      accountId,
      displayName: name,
      fields: {
        name,
        scope,
        description: fields["description"] ?? "",
        ruleCount: 0,
        defaultAction: fields["defaultAction"] ?? "ALLOW",
        capacity: 0,
      },
      resolvedOutputs: {
        webAclArn: String(summary["ARN"] ?? ""),
        webAclId: String(summary["Id"] ?? ""),
      },
      secretStates: [],
      externalId: name,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }
  if (typeId === "cloudtrail-trail") {
    const name = fields["name"] ?? "";
    const s3BucketName = fields["s3BucketName"] ?? "";
    await ctx.json(
      "cloudtrail",
      "com.amazonaws.cloudtrail.v20131101.CloudTrail_20131101.CreateTrail",
      {
        Name: name,
        S3BucketName: s3BucketName,
        IsMultiRegionTrail: fields["isMultiRegion"] === "true",
        IncludeGlobalServiceEvents: fields["includeGlobalServiceEvents"] !== "false",
      },
    );
    const now = new Date().toISOString();
    return {
      id: ctx.makeId(accountId, "cloudtrail-trail", name),
      pluginId: "aws",
      resourceTypeId: "cloudtrail-trail",
      accountId,
      displayName: name,
      fields: {
        name,
        s3BucketName,
        isMultiRegion: fields["isMultiRegion"] === "true",
        isOrganizationTrail: false,
        logFileValidationEnabled: false,
        includeGlobalServiceEvents: fields["includeGlobalServiceEvents"] !== "false",
        status: true,
      },
      resolvedOutputs: { trailArn: "" },
      secretStates: [],
      externalId: name,
      createdAt: now,
      updatedAt: now,
    };
  }
  if (typeId === "api-gateway") {
    const name = fields["name"] ?? "";
    const protocolType = fields["protocolType"] ?? "HTTP";
    const description = fields["description"] ?? "";
    const host = ctx.hostForService("apigateway");
    const url = `https://${host}/v2/apis`;
    const bodyStr = JSON.stringify({
      name,
      protocolType,
      description,
    });
    const headers = await signRequest({
      method: "POST",
      url,
      headers: { Host: host, "Content-Type": "application/json" },
      body: bodyStr,
      service: "apigateway",
      credentials: ctx.creds,
    });
    const res = await fetch(url, { method: "POST", headers, body: bodyStr });
    if (!res.ok) throw new Error(`API Gateway create failed: ${res.status}: ${await res.text()}`);
    const result = (await res.json()) as Record<string, unknown>;
    const apiId = String(result["apiId"] ?? "");
    const now = new Date().toISOString();
    return {
      id: ctx.makeId(accountId, "api-gateway", apiId),
      pluginId: "aws",
      resourceTypeId: "api-gateway",
      accountId,
      displayName: name,
      fields: {
        name,
        apiId,
        protocolType,
        description,
        routeCount: 0,
        createdDate: now,
      },
      resolvedOutputs: {
        apiEndpoint: String(result["apiEndpoint"] ?? ""),
        apiId,
      },
      secretStates: [],
      externalId: apiId,
      createdAt: now,
      updatedAt: now,
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
  throw new Error(`AWS plugin: createResource not supported for type "${typeId}"`);
}
