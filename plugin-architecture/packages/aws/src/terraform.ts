import type {
  TerraformExportCapability,
  TerraformExportResult,
  TerraformValue,
} from "@infrawrench/plugin-base";
import { fieldBool, fieldNumber, fieldString, tf } from "@infrawrench/plugin-base";

const splitIds = (value: string | undefined): TerraformValue[] =>
  (value ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean)
    .map(tf.str);

/**
 * Terraform mapping for AWS — provider `hashicorp/aws`.
 *
 * Attribute names and import IDs were verified against the AWS provider docs.
 * Lambda functions need a deployment package or image URI, DynamoDB tables need
 * key attribute types, ElastiCache clusters need a parameter group, and IAM
 * roles need an assume-role policy. Those required values are not persisted by
 * the listers, so they are deliberately not exported.
 */
export const awsTerraformExport: TerraformExportCapability = {
  provider: { name: "aws", source: "hashicorp/aws", version: "~> 6.0" },
  providerConfig: {
    access_key: tf.ref("var.aws_access_key_id"),
    secret_key: tf.ref("var.aws_secret_access_key"),
    region: tf.ref("var.aws_region"),
  },
  variables: [
    { name: "aws_access_key_id", description: "AWS access key ID" },
    { name: "aws_secret_access_key", description: "AWS secret access key", sensitive: true },
    { name: "aws_region", description: "AWS region for regional resources" },
  ],
  supportedResourceTypeIds: [
    "ec2-instance",
    "s3-bucket",
    "vpc",
    "subnet",
    "security-group",
    "ebs-volume",
    "rds-instance",
    "sqs-queue",
    "sns-topic",
    "route53-hosted-zone",
    "efs-file-system",
  ],
  mapResource(resource): TerraformExportResult | null {
    switch (resource.resourceTypeId) {
      case "ec2-instance": {
        const name = fieldString(resource, "name") || resource.displayName;
        const instanceType = fieldString(resource, "instanceType");
        const ami = fieldString(resource, "imageId");
        if (!name || !instanceType || !ami) return null;
        const attributes: Record<string, TerraformValue> = {
          ami: tf.str(ami),
          instance_type: tf.str(instanceType),
          tags: tf.map({ Name: tf.str(name) }),
        };
        const subnetId = fieldString(resource, "subnetId");
        if (subnetId) attributes["subnet_id"] = tf.str(subnetId);
        const securityGroupIds = splitIds(fieldString(resource, "securityGroupIds"));
        if (securityGroupIds.length > 0)
          attributes["vpc_security_group_ids"] = tf.list(securityGroupIds);
        return {
          resource: { type: "aws_instance", name, attributes, importId: resource.externalId },
        };
      }
      case "s3-bucket": {
        const bucket = fieldString(resource, "name") || resource.displayName;
        if (!bucket) return null;
        return {
          resource: {
            type: "aws_s3_bucket",
            name: bucket,
            attributes: { bucket: tf.str(bucket) },
            importId: resource.externalId || bucket,
          },
        };
      }
      case "vpc": {
        const name = fieldString(resource, "name") || resource.displayName;
        const cidrBlock = fieldString(resource, "cidrBlock");
        if (!name || !cidrBlock) return null;
        const attributes: Record<string, TerraformValue> = { cidr_block: tf.str(cidrBlock) };
        const tenancy = fieldString(resource, "tenancy");
        if (tenancy) attributes["instance_tenancy"] = tf.str(tenancy);
        attributes["tags"] = tf.map({ Name: tf.str(name) });
        return { resource: { type: "aws_vpc", name, attributes, importId: resource.externalId } };
      }
      case "subnet": {
        const name = fieldString(resource, "name") || resource.displayName;
        const vpcId = fieldString(resource, "vpcId");
        const cidrBlock = fieldString(resource, "cidrBlock");
        const availabilityZone = fieldString(resource, "availabilityZone");
        if (!name || !vpcId || !cidrBlock || !availabilityZone) return null;
        const attributes: Record<string, TerraformValue> = {
          vpc_id: tf.str(vpcId),
          cidr_block: tf.str(cidrBlock),
          availability_zone: tf.str(availabilityZone),
          tags: tf.map({ Name: tf.str(name) }),
        };
        if (fieldBool(resource, "mapPublicIp"))
          attributes["map_public_ip_on_launch"] = tf.bool(true);
        return {
          resource: { type: "aws_subnet", name, attributes, importId: resource.externalId },
        };
      }
      case "security-group": {
        const name = fieldString(resource, "groupName") || resource.displayName;
        const vpcId = fieldString(resource, "vpcId");
        if (!name || !vpcId) return null;
        const attributes: Record<string, TerraformValue> = {
          name: tf.str(name),
          vpc_id: tf.str(vpcId),
        };
        const description = fieldString(resource, "description");
        if (description) attributes["description"] = tf.str(description);
        return {
          resource: {
            type: "aws_security_group",
            name,
            attributes,
            importId: resource.externalId,
            comments: ["Ingress and egress rules are not persisted; add them before applying."],
          },
        };
      }
      case "ebs-volume": {
        const name = fieldString(resource, "volumeId") || resource.displayName;
        const availabilityZone = fieldString(resource, "availabilityZone");
        const size = fieldNumber(resource, "sizeGb");
        const type = fieldString(resource, "volumeType");
        if (!name || !availabilityZone || size === undefined || !type) return null;
        const attributes: Record<string, TerraformValue> = {
          availability_zone: tf.str(availabilityZone),
          size: tf.num(size),
          type: tf.str(type),
        };
        if (fieldBool(resource, "encrypted")) attributes["encrypted"] = tf.bool(true);
        return {
          resource: {
            type: "aws_ebs_volume",
            name,
            attributes,
            importId: resource.externalId,
            comments: ["Attachments are managed separately with aws_volume_attachment."],
          },
        };
      }
      case "rds-instance": {
        const name = fieldString(resource, "dbInstanceId") || resource.displayName;
        const engine = fieldString(resource, "engine");
        const instanceClass = fieldString(resource, "instanceClass");
        if (!name || !engine || !instanceClass) return null;
        const attributes: Record<string, TerraformValue> = {
          identifier: tf.str(name),
          engine: tf.str(engine),
          instance_class: tf.str(instanceClass),
          skip_final_snapshot: tf.bool(true),
        };
        const engineVersion = fieldString(resource, "engineVersion");
        if (engineVersion) attributes["engine_version"] = tf.str(engineVersion);
        const allocatedStorage = fieldNumber(resource, "allocatedStorage");
        if (allocatedStorage !== undefined)
          attributes["allocated_storage"] = tf.num(allocatedStorage);
        if (fieldBool(resource, "multiAZ")) attributes["multi_az"] = tf.bool(true);
        const securityGroupIds = splitIds(fieldString(resource, "securityGroupIds"));
        if (securityGroupIds.length > 0)
          attributes["vpc_security_group_ids"] = tf.list(securityGroupIds);
        return {
          resource: {
            type: "aws_db_instance",
            name,
            attributes,
            importId: resource.externalId || name,
            comments: [
              "The stored state lacks master credentials and full backup/subnet configuration.",
              "Review this imported instance carefully before changing or applying it.",
            ],
          },
        };
      }
      case "sqs-queue": {
        const name = fieldString(resource, "queueName") || resource.displayName;
        if (!name) return null;
        const attributes: Record<string, TerraformValue> = { name: tf.str(name) };
        if (fieldBool(resource, "isFifo")) attributes["fifo_queue"] = tf.bool(true);
        return {
          resource: { type: "aws_sqs_queue", name, attributes, importId: resource.externalId },
        };
      }
      case "sns-topic": {
        const name = fieldString(resource, "topicName") || resource.displayName;
        if (!name) return null;
        const attributes: Record<string, TerraformValue> = { name: tf.str(name) };
        if (fieldBool(resource, "isFifo")) attributes["fifo_topic"] = tf.bool(true);
        return {
          resource: { type: "aws_sns_topic", name, attributes, importId: resource.externalId },
        };
      }
      case "route53-hosted-zone": {
        const name = fieldString(resource, "name") || resource.displayName;
        if (!name) return null;
        const attributes: Record<string, TerraformValue> = { name: tf.str(name) };
        const comment = fieldString(resource, "comment");
        if (comment) attributes["comment"] = tf.str(comment);
        if (fieldBool(resource, "isPrivate")) {
          return null;
        }
        return {
          resource: { type: "aws_route53_zone", name, attributes, importId: resource.externalId },
        };
      }
      case "efs-file-system": {
        const name =
          fieldString(resource, "name") ||
          fieldString(resource, "fileSystemId") ||
          resource.displayName;
        if (!name) return null;
        const attributes: Record<string, TerraformValue> = {};
        const performanceMode = fieldString(resource, "performanceMode");
        if (performanceMode) attributes["performance_mode"] = tf.str(performanceMode);
        const throughputMode = fieldString(resource, "throughputMode");
        if (throughputMode) attributes["throughput_mode"] = tf.str(throughputMode);
        if (fieldBool(resource, "encrypted")) attributes["encrypted"] = tf.bool(true);
        return {
          resource: {
            type: "aws_efs_file_system",
            name,
            attributes,
            importId: resource.externalId,
          },
        };
      }
      default:
        return null;
    }
  },
};
