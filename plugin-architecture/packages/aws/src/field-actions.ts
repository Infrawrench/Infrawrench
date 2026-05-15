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
import { generateServiceRole } from "./iam-role-generator.js";

interface FieldActionEntry {
  /** Action id surfaced in `CreateFieldConfig.actions`. */
  actionId: string;
  /** Build the role for the given resource type. */
  generate(
    creds: AwsCredentials,
  ): Promise<{ value: string; option?: { id: string; label: string } }>;
}

/** Common AWS-managed-policy ARNs referenced by multiple actions. */
const POLICY = {
  lambdaBasicExec: "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole",
  stepFunctionsBasicExec: "arn:aws:iam::aws:policy/service-role/AWSStepFunctionsBasicExecutionRole",
  codeBuildDeveloperAccess: "arn:aws:iam::aws:policy/AWSCodeBuildDeveloperAccess",
  ecsTaskExec: "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy",
  eksClusterPolicy: "arn:aws:iam::aws:policy/AmazonEKSClusterPolicy",
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
};

export async function executeFieldAction(
  creds: AwsCredentials,
  typeId: string,
  fieldKey: string,
  actionId: string,
): Promise<{ value: string; option?: { id: string; label: string } }> {
  const entries = FIELD_ACTIONS[`${typeId}:${fieldKey}`] ?? [];
  const entry = entries.find((e) => e.actionId === actionId);
  if (!entry) {
    throw new Error(
      `AWS plugin: no field action registered for ${typeId}.${fieldKey} / ${actionId}`,
    );
  }
  return entry.generate(creds);
}
