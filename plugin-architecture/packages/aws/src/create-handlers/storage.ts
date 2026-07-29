import type { CreateResourceConfig, ResourceInstance } from "@infrawrench/plugin-base";
import { fetchSigned } from "../signed-request.js";
import { AWS_REGIONS } from "../constants.js";
import type { AwsCreateContext } from "./shared.js";

export async function storageGetCreateConfig(
  ctx: AwsCreateContext,
  typeId: string,
  _parentResourceId?: string,
): Promise<CreateResourceConfig | null> {
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
  if (typeId === "ecr-repository") {
    return {
      fields: [
        { key: "repositoryName", label: "Repository Name", kind: "text", required: true },
        {
          key: "region",
          label: "Region",
          kind: "region-picker",
          required: true,
          regions: AWS_REGIONS,
          defaultValue: ctx.creds.region,
        },
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
          key: "region",
          label: "Region",
          kind: "region-picker",
          required: true,
          regions: AWS_REGIONS,
          defaultValue: ctx.creds.region,
        },
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
  return null;
}

export async function storageCreateResource(
  ctx: AwsCreateContext,
  typeId: string,
  accountId: string,
  fields: Record<string, string>,
  _parentResourceId?: string,
): Promise<ResourceInstance | null> {
  if (typeId === "s3-bucket") {
    const region = fields["region"] ?? ctx.creds.region;
    const rctx = ctx.withRegion(region);
    const bucketName = fields["name"] ?? "";
    const host = `${bucketName}.s3.${region}.amazonaws.com`;
    const url = `https://${host}/`;
    const bodyXml =
      region === "us-east-1"
        ? ""
        : `<CreateBucketConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><LocationConstraint>${region}</LocationConstraint></CreateBucketConfiguration>`;
    await fetchSigned({
      method: "PUT",
      url,
      headers: { Host: host },
      ...(bodyXml ? { body: bodyXml } : {}),
      service: "s3",
      credentials: rctx.creds,
    });

    return {
      id: ctx.makeId(accountId, "s3-bucket", bucketName),
      pluginId: "aws",
      resourceTypeId: "s3-bucket",
      accountId,
      displayName: bucketName,
      fields: {
        name: bucketName,
        region,
        creationDate: new Date().toISOString(),
      },
      resolvedOutputs: {
        bucketArn: `arn:aws:s3:::${bucketName}`,
        endpoint: `https://${bucketName}.s3.${region}.amazonaws.com`,
      },
      secretStates: [],
      externalId: bucketName,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }
  if (typeId === "ecr-repository") {
    const region = fields["region"] ?? ctx.creds.region;
    const rctx = ctx.withRegion(region);
    const repoName = fields["repositoryName"] ?? "";
    const data = await rctx.json<{ repository?: Record<string, unknown> }>(
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
    const repositoryUri = String(repo["repositoryUri"] ?? "");
    return {
      id: ctx.makeId(accountId, "ecr-repository", repoName),
      pluginId: "aws",
      resourceTypeId: "ecr-repository",
      accountId,
      displayName: repoName,
      fields: {
        repositoryName: repoName,
        region,
        registryId: String(repo["registryId"] ?? ""),
        imageCount: 0,
        imageScanOnPush: fields["scanOnPush"] === "true",
        encryptionType: "AES256",
      },
      resolvedOutputs: {
        repositoryUri,
        repositoryArn: String(repo["repositoryArn"] ?? ""),
        // Registry host for docker login — the repositoryUri minus the
        // per-repo path. The docker credentials themselves (username /
        // password / dockerConfigJson) are minted on demand in resolveOutput.
        serverUrl: repositoryUri.split("/")[0] ?? "",
      },
      secretStates: [],
      externalId: repoName,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }
  if (typeId === "efs-file-system") {
    const region = fields["region"] ?? ctx.creds.region;
    const rctx = ctx.withRegion(region);
    const host = rctx.hostForService("elasticfilesystem");
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
    const res = await fetchSigned({
      method: "POST",
      url,
      headers: { Host: host, "Content-Type": "application/json" },
      body: bodyStr,
      service: "elasticfilesystem",
      credentials: rctx.creds,
    });
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
        region,
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
  return null;
}
