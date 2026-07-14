/**
 * Dispatcher for create-form field actions. The plugin declares actions on
 * specific fields (e.g. a "+ Generate role" button next to a Lambda role
 * selector); this module maps a (typeId, fieldKey, actionId) triple to the
 * concrete work — typically minting an IAM role via the generic
 * `generateServiceRole` helper — and returns the new value plus a synthetic
 * option entry the host can splice into the select's options.
 *
 * To support a new field action, add an entry below. Keep entries thin:
 * each one should declare *what* role/credential to generate and let the
 * shared helper handle CreateRole + AttachRolePolicy + propagation wait.
 */

import type { AwsCredentials } from "./auth.js";
import { ensureArray } from "./xml.js";
import { ec2Call } from "./client-transport.js";
import { generateServiceRole } from "./iam-role-generator.js";

interface FieldActionEntry {
  /** Action id surfaced in `CreateFieldConfig.actions`. */
  actionId: string;
  /**
   * Mint the resource. `fields` is the outer create form's current values
   * (region, instance name, …); `actionFields` is the action's own inline
   * mini-form values (declared via `FieldAction.formFields`). Most existing
   * entries ignore both — they only mint home-region IAM roles.
   */
  generate(
    creds: AwsCredentials,
    fields: Record<string, string>,
    actionFields: Record<string, string>,
  ): Promise<{ value: string; option?: { id: string; label: string } }>;
}

/** Common AWS-managed-policy ARNs referenced by multiple actions. */
const POLICY = {
  lambdaBasicExec: "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole",
  stepFunctionsBasicExec: "arn:aws:iam::aws:policy/service-role/AWSStepFunctionsBasicExecutionRole",
  codeBuildDeveloperAccess: "arn:aws:iam::aws:policy/AWSCodeBuildDeveloperAccess",
  ecsTaskExec: "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy",
  eksClusterPolicy: "arn:aws:iam::aws:policy/AmazonEKSClusterPolicy",
  eksWorkerNodePolicy: "arn:aws:iam::aws:policy/AmazonEKSWorkerNodePolicy",
  eksCniPolicy: "arn:aws:iam::aws:policy/AmazonEKS_CNI_Policy",
  ec2ContainerRegistryReadOnly: "arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryReadOnly",
  sageMakerFullAccess: "arn:aws:iam::aws:policy/AmazonSageMakerFullAccess",
};

/**
 * Keyed by `${typeId}:${fieldKey}` so a single field can host multiple
 * actions (the action id then distinguishes them).
 */
const FIELD_ACTIONS: Record<string, FieldActionEntry[]> = {
  "lambda-function:role": [
    {
      actionId: "generate-role",
      generate: async (creds) => {
        const result = await generateServiceRole(creds, {
          principalService: "lambda.amazonaws.com",
          managedPolicyArns: [POLICY.lambdaBasicExec],
          namePrefix: "infrawrench-lambda-exec-",
          description: "Lambda execution role created by Infrawrench",
        });
        return {
          value: result.roleArn,
          option: { id: result.roleArn, label: result.roleName },
        };
      },
    },
  ],
  "step-function:roleArn": [
    {
      actionId: "generate-role",
      generate: async (creds) => {
        const result = await generateServiceRole(creds, {
          principalService: "states.amazonaws.com",
          managedPolicyArns: [POLICY.stepFunctionsBasicExec],
          namePrefix: "infrawrench-states-",
          description: "Step Functions state-machine role created by Infrawrench",
        });
        return {
          value: result.roleArn,
          option: { id: result.roleArn, label: result.roleName },
        };
      },
    },
  ],
  "codebuild-project:serviceRole": [
    {
      actionId: "generate-role",
      generate: async (creds) => {
        const result = await generateServiceRole(creds, {
          principalService: "codebuild.amazonaws.com",
          managedPolicyArns: [POLICY.codeBuildDeveloperAccess],
          namePrefix: "infrawrench-codebuild-",
          description: "CodeBuild service role created by Infrawrench",
        });
        return {
          value: result.roleArn,
          option: { id: result.roleArn, label: result.roleName },
        };
      },
    },
  ],
  "ecs-service:taskRoleArn": [
    {
      actionId: "generate-role",
      generate: async (creds) => {
        const result = await generateServiceRole(creds, {
          principalService: "ecs-tasks.amazonaws.com",
          managedPolicyArns: [POLICY.ecsTaskExec],
          namePrefix: "infrawrench-ecs-task-",
          description: "ECS task execution role created by Infrawrench",
        });
        return {
          value: result.roleArn,
          option: { id: result.roleArn, label: result.roleName },
        };
      },
    },
  ],
  "eks-cluster:roleArn": [
    {
      actionId: "generate-role",
      generate: async (creds) => {
        const result = await generateServiceRole(creds, {
          principalService: "eks.amazonaws.com",
          managedPolicyArns: [POLICY.eksClusterPolicy],
          namePrefix: "infrawrench-eks-cluster-",
          description: "EKS cluster role created by Infrawrench",
        });
        return {
          value: result.roleArn,
          option: { id: result.roleArn, label: result.roleName },
        };
      },
    },
  ],
  "eks-cluster:nodeRoleArn": [
    {
      actionId: "generate-role",
      generate: async (creds) => {
        const result = await generateServiceRole(creds, {
          principalService: "ec2.amazonaws.com",
          managedPolicyArns: [
            POLICY.eksWorkerNodePolicy,
            POLICY.eksCniPolicy,
            POLICY.ec2ContainerRegistryReadOnly,
          ],
          namePrefix: "infrawrench-eks-node-",
          description: "EKS managed node group role created by Infrawrench",
        });
        return {
          value: result.roleArn,
          option: { id: result.roleArn, label: result.roleName },
        };
      },
    },
  ],
  "sagemaker-endpoint:roleArn": [
    {
      actionId: "generate-role",
      generate: async (creds) => {
        const result = await generateServiceRole(creds, {
          principalService: "sagemaker.amazonaws.com",
          managedPolicyArns: [POLICY.sageMakerFullAccess],
          namePrefix: "infrawrench-sagemaker-",
          description: "SageMaker execution role created by Infrawrench",
        });
        return {
          value: result.roleArn,
          option: { id: result.roleArn, label: result.roleName },
        };
      },
    },
  ],
  "ec2-instance:securityGroup": [
    {
      actionId: "create-sg",
      generate: async (creds, fields, actionFields) => {
        const region = fields["region"] || creds.region;
        const rcreds: AwsCredentials = { ...creds, region };
        const name = (actionFields["sgName"] ?? "").trim() || `infrawrench-sg-${Date.now()}`;
        const description =
          (actionFields["sgDescription"] ?? "").trim() || "Created by Infrawrench";
        const cidr = (actionFields["sgSourceCidr"] ?? "").trim() || "0.0.0.0/0";

        // SGs live in a VPC. Prefer the VPC the user picked above; otherwise
        // fall back to the region's default VPC. The picker stores `vpcId`
        // as the field value (see ec2-instance schema).
        let vpcId = (fields["network"] ?? "").trim();
        if (!vpcId) {
          const vpcs = await ec2Call<Record<string, unknown>>(rcreds, "DescribeVpcs", {
            "Filter.1.Name": "is-default",
            "Filter.1.Value": "true",
          });
          const vpcSet = vpcs["vpcSet"] as Record<string, unknown> | undefined;
          const items = ensureArray(vpcSet?.["item"]) as Record<string, unknown>[];
          vpcId = String(items[0]?.["vpcId"] ?? "");
          if (!vpcId) {
            throw new Error(
              "No VPC selected and no default VPC found in this region. Pick a VPC above first, or create one in the AWS console.",
            );
          }
        }

        const created = await ec2Call<Record<string, unknown>>(rcreds, "CreateSecurityGroup", {
          GroupName: name,
          GroupDescription: description,
          VpcId: vpcId,
        });
        const groupId = String(created["groupId"] ?? "");
        if (!groupId) throw new Error("CreateSecurityGroup returned no groupId");

        // Authorize one ingress rule per enabled port. AuthorizeSecurityGroupIngress
        // accepts arrays via `IpPermissions.N.…`; here we batch all enabled
        // ports into a single call so partial failures don't leave the group
        // half-configured.
        const ports: Array<{ from: number; to: number; label: string }> = [];
        if (actionFields["sgAllowSsh"] === "true") {
          ports.push({ from: 22, to: 22, label: "SSH" });
        }
        if (actionFields["sgAllowHttp"] === "true") {
          ports.push({ from: 80, to: 80, label: "HTTP" });
        }
        if (actionFields["sgAllowHttps"] === "true") {
          ports.push({ from: 443, to: 443, label: "HTTPS" });
        }
        if (ports.length > 0) {
          const params: Record<string, string> = { GroupId: groupId };
          ports.forEach((p, i) => {
            const n = i + 1;
            params[`IpPermissions.${n}.IpProtocol`] = "tcp";
            params[`IpPermissions.${n}.FromPort`] = String(p.from);
            params[`IpPermissions.${n}.ToPort`] = String(p.to);
            params[`IpPermissions.${n}.IpRanges.1.CidrIp`] = cidr;
            params[`IpPermissions.${n}.IpRanges.1.Description`] =
              `${p.label} from ${cidr} (Infrawrench)`;
          });
          await ec2Call(rcreds, "AuthorizeSecurityGroupIngress", params);
        }

        return {
          value: groupId,
          option: { id: groupId, label: `${name} (${groupId})` },
        };
      },
    },
  ],
};

export async function executeFieldAction(
  creds: AwsCredentials,
  typeId: string,
  fieldKey: string,
  actionId: string,
  fields: Record<string, string>,
  actionFields: Record<string, string>,
): Promise<{ value: string; option?: { id: string; label: string } }> {
  const entries = FIELD_ACTIONS[`${typeId}:${fieldKey}`] ?? [];
  const entry = entries.find((e) => e.actionId === actionId);
  if (!entry) {
    throw new Error(
      `AWS plugin: no field action registered for ${typeId}.${fieldKey} / ${actionId}`,
    );
  }
  return entry.generate(creds, fields, actionFields);
}
