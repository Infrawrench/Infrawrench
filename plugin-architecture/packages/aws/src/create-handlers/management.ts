import type { CreateResourceConfig, ResourceInstance } from "@infrawrench/plugin-base";
import type { AwsCreateContext } from "./shared.js";

export async function managementGetCreateConfig(
  _ctx: AwsCreateContext,
  typeId: string,
  _parentResourceId?: string,
): Promise<CreateResourceConfig | null> {
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
  if (typeId === "glue-database") {
    return {
      fields: [
        { key: "name", label: "Database Name", kind: "text", required: true },
        { key: "description", label: "Description", kind: "text", required: false },
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
  return null;
}

export async function managementCreateResource(
  ctx: AwsCreateContext,
  typeId: string,
  accountId: string,
  fields: Record<string, string>,
  _parentResourceId?: string,
): Promise<ResourceInstance | null> {
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
  return null;
}
