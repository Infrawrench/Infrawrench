import type { ResourceInstance } from "@infrawrench/plugin-base";
import { type ListerContext } from "./shared.js";

export async function listGcsBuckets(
  ctx: ListerContext,
  accountId: string,
  p: string,
): Promise<ResourceInstance[]> {
  const items = await ctx.paginate<Record<string, unknown>>(
    `https://storage.googleapis.com/storage/v1/b`,
    "items",
    { project: p },
  );
  return items.map((b) => {
    const name = String(b["name"]);
    const versioning = !!(b["versioning"] as Record<string, unknown> | undefined)?.["enabled"];
    return {
      id: ctx.id(accountId, "gcs-bucket", name),
      pluginId: "gcp",
      resourceTypeId: "gcs-bucket",
      accountId,
      displayName: name,
      fields: {
        name,
        location: String(b["location"] ?? ""),
        storageClass: String(b["storageClass"] ?? ""),
        publicAccessPrevention: String(
          (b["iamConfiguration"] as Record<string, unknown> | undefined)?.[
            "publicAccessPrevention"
          ] ?? "",
        ),
        versioning,
      },
      resolvedOutputs: { endpoint: `https://storage.googleapis.com/${name}` },
      secretStates: [],
      externalId: name,
      createdAt: String(b["timeCreated"] ?? ctx.now()),
      updatedAt: String(b["updated"] ?? ctx.now()),
    };
  });
}

export async function listArtifactRegistryRepos(
  ctx: ListerContext,
  accountId: string,
  p: string,
): Promise<ResourceInstance[]> {
  const items = await ctx.paginate<Record<string, unknown>>(
    `https://artifactregistry.googleapis.com/v1/projects/${p}/locations/-/repositories`,
    "repositories",
  );
  return items.map((repo) => {
    const fullName = String(repo["name"]);
    const name = fullName.split("/").pop() ?? "";
    const location = fullName.split("/")[3] ?? "";
    const sizeBytes = Number(repo["sizeBytes"] ?? 0);
    const sizeLabel =
      sizeBytes > 1_073_741_824
        ? `${(sizeBytes / 1_073_741_824).toFixed(1)} GB`
        : sizeBytes > 1_048_576
          ? `${(sizeBytes / 1_048_576).toFixed(1)} MB`
          : `${Math.round(sizeBytes / 1024)} KB`;
    return {
      id: ctx.id(accountId, "artifact-registry-repo", fullName),
      pluginId: "gcp",
      resourceTypeId: "artifact-registry-repo",
      accountId,
      displayName: name,
      fields: {
        name,
        location,
        format: String(repo["format"] ?? ""),
        description: String(repo["description"] ?? ""),
        sizeBytes: sizeLabel,
      },
      resolvedOutputs: {},
      secretStates: [],
      externalId: fullName,
      createdAt: String(repo["createTime"] ?? ctx.now()),
      updatedAt: String(repo["updateTime"] ?? ctx.now()),
    };
  });
}

export async function listFilestoreInstances(
  ctx: ListerContext,
  accountId: string,
  p: string,
): Promise<ResourceInstance[]> {
  const items = await ctx.paginate<Record<string, unknown>>(
    `https://file.googleapis.com/v1/projects/${p}/locations/-/instances`,
    "instances",
  );
  return items.map((inst) => {
    const fullName = String(inst["name"]);
    const name = fullName.split("/").pop() ?? "";
    const location = fullName.split("/locations/")[1]?.split("/")[0] ?? "";
    const networks = inst["networks"] as Array<Record<string, unknown>> | undefined;
    const network =
      String(networks?.[0]?.["network"] ?? "")
        .split("/")
        .pop() ?? "";
    const ipAddresses = networks?.[0]?.["ipAddresses"] as string[] | undefined;
    const fileShares = inst["fileShares"] as Array<Record<string, unknown>> | undefined;
    const fileShareName = String(fileShares?.[0]?.["name"] ?? "");
    const capacityGb = Number(fileShares?.[0]?.["capacityGb"] ?? 0);
    return {
      id: ctx.id(accountId, "filestore-instance", fullName),
      pluginId: "gcp",
      resourceTypeId: "filestore-instance",
      accountId,
      displayName: name,
      fields: {
        name,
        location,
        tier: String(inst["tier"] ?? ""),
        state: String(inst["state"] ?? ""),
        capacityGb,
        network,
        fileShareName,
        ipAddress: ipAddresses?.[0] ?? "",
      },
      resolvedOutputs: { ipAddress: ipAddresses?.[0] ?? "" },
      secretStates: [],
      externalId: fullName,
      createdAt: String(inst["createTime"] ?? ctx.now()),
      updatedAt: ctx.now(),
    };
  });
}
