import type { CreateResourceConfig, ResourceInstance } from "@infrawrench/plugin-base";
import { GCP_REGIONS, regionOption } from "./regions.js";
import type { GcpCreateContext } from "./create-context.js";

export const storageCreateConfigHandlers: Record<
  string,
  (ctx: GcpCreateContext, parentResourceId?: string) => Promise<CreateResourceConfig>
> = {
  "gcs-bucket": async (ctx, parentResourceId) => {
    return {
      fields: [
        {
          key: "name",
          label: "Bucket Name",
          kind: "text",
          required: true,
          description: "Globally unique bucket name",
        },
        {
          key: "location",
          label: "Location",
          kind: "region-picker",
          required: true,
          regions: [
            { id: "US", label: "US (multi-region)" },
            { id: "EU", label: "EU (multi-region)" },
            { id: "ASIA", label: "Asia (multi-region)" },
            regionOption("us-central1"),
            regionOption("us-east1"),
            regionOption("us-west1"),
            regionOption("europe-west1"),
            regionOption("europe-west4"),
            regionOption("asia-east1"),
            regionOption("asia-southeast1"),
          ],
          defaultValue: "US",
        },
        {
          key: "storageClass",
          label: "Storage Class",
          kind: "select",
          required: true,
          options: [
            { id: "STANDARD", label: "Standard" },
            { id: "NEARLINE", label: "Nearline" },
            { id: "COLDLINE", label: "Coldline" },
            { id: "ARCHIVE", label: "Archive" },
          ],
          defaultValue: "STANDARD",
        },
      ],
    };
  },
  "artifact-registry-repo": async (ctx, parentResourceId) => {
    return {
      fields: [
        {
          key: "name",
          label: "Repository Name",
          kind: "text",
          required: true,
        },
        {
          key: "location",
          label: "Location",
          kind: "region-picker",
          required: true,
          regions: GCP_REGIONS,
          defaultValue: "us-central1",
        },
        {
          key: "format",
          label: "Format",
          kind: "select",
          required: true,
          options: [
            { id: "DOCKER", label: "Docker" },
            { id: "NPM", label: "NPM" },
            { id: "MAVEN", label: "Maven" },
            { id: "PYTHON", label: "Python" },
            { id: "APT", label: "APT" },
            { id: "YUM", label: "YUM" },
            { id: "GO", label: "Go" },
            { id: "HELM", label: "Helm" },
          ],
          defaultValue: "DOCKER",
        },
      ],
    };
  },
  "filestore-instance": async (ctx, parentResourceId) => {
    return {
      fields: [
        {
          key: "name",
          label: "Instance Name",
          kind: "text",
          required: true,
        },
        {
          key: "location",
          label: "Zone",
          kind: "region-picker",
          required: true,
          regions: [
            regionOption("us-central1-a"),
            regionOption("us-central1-b"),
            regionOption("us-east1-b"),
            regionOption("us-west1-a"),
            regionOption("europe-west1-b"),
            regionOption("europe-west4-a"),
            regionOption("asia-east1-a"),
          ],
          defaultValue: "us-central1-a",
        },
        {
          key: "tier",
          label: "Tier",
          kind: "select",
          required: true,
          options: [
            { id: "BASIC_HDD", label: "Basic HDD" },
            { id: "BASIC_SSD", label: "Basic SSD" },
            { id: "HIGH_SCALE_SSD", label: "High Scale SSD" },
            { id: "ENTERPRISE", label: "Enterprise" },
          ],
          defaultValue: "BASIC_HDD",
        },
        {
          key: "fileShareName",
          label: "File Share Name",
          kind: "text",
          required: true,
          description: "Name of the file share (e.g. vol1)",
        },
        {
          key: "capacityGb",
          label: "Capacity (GB)",
          kind: "number",
          required: true,
          defaultValue: "1024",
          minValue: 1024,
          maxValue: 65536,
        },
      ],
    };
  },
};

export const storageCreateResourceHandlers: Record<
  string,
  (
    ctx: GcpCreateContext,
    accountId: string,
    fields: Record<string, string>,
    parentResourceId?: string,
  ) => Promise<ResourceInstance>
> = {
  "gcs-bucket": async (ctx, accountId, fields, parentResourceId) => {
    const p = ctx.project;
    const tok = await ctx.token();
    const name = fields["name"] ?? "";
    const location = fields["location"] ?? "US";
    const storageClass = fields["storageClass"] ?? "STANDARD";

    const res = await fetch(`https://storage.googleapis.com/storage/v1/b?project=${p}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name, location, storageClass }),
    });
    if (!res.ok) throw new Error(`GCS API ${res.status}: ${await res.text()}`);
    const bucket = (await res.json()) as Record<string, unknown>;
    const now = ctx.now();
    return {
      id: ctx.id(accountId, "gcs-bucket", name),
      pluginId: "gcp",
      resourceTypeId: "gcs-bucket",
      accountId,
      displayName: name,
      fields: {
        name,
        location: String(bucket["location"] ?? location),
        storageClass: String(bucket["storageClass"] ?? storageClass),
        publicAccessPrevention: "",
        versioning: false,
      },
      resolvedOutputs: {
        endpoint: `https://storage.googleapis.com/${name}`,
        bucketName: name,
      },
      secretStates: [],
      externalId: name,
      createdAt: String(bucket["timeCreated"] ?? now),
      updatedAt: now,
    };
  },
  "artifact-registry-repo": async (ctx, accountId, fields, parentResourceId) => {
    const p = ctx.project;
    const tok = await ctx.token();
    const name = fields["name"] ?? "";
    const location = fields["location"] ?? "";
    const format = fields["format"] ?? "DOCKER";

    const res = await fetch(
      `https://artifactregistry.googleapis.com/v1/projects/${p}/locations/${location}/repositories?repositoryId=${name}`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
        body: JSON.stringify({ format }),
      },
    );
    if (!res.ok) throw new Error(`Artifact Registry API ${res.status}: ${await res.text()}`);
    const now = ctx.now();
    const fullName = `projects/${p}/locations/${location}/repositories/${name}`;
    return {
      id: ctx.id(accountId, "artifact-registry-repo", fullName),
      pluginId: "gcp",
      resourceTypeId: "artifact-registry-repo",
      accountId,
      displayName: name,
      fields: {
        name,
        location,
        format,
        description: "",
        sizeBytes: "0 KB",
      },
      resolvedOutputs: {},
      secretStates: [],
      externalId: fullName,
      createdAt: now,
      updatedAt: now,
    };
  },
  "filestore-instance": async (ctx, accountId, fields, parentResourceId) => {
    const p = ctx.project;
    const tok = await ctx.token();
    const name = fields["name"] ?? "";
    const location = fields["location"] ?? "";
    const tier = fields["tier"] ?? "BASIC_HDD";
    const fileShareName = fields["fileShareName"] ?? "";
    const capacityGb = Number(fields["capacityGb"] || 1024);

    const res = await fetch(
      `https://file.googleapis.com/v1/projects/${p}/locations/${location}/instances?instanceId=${name}`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          tier,
          fileShares: [{ name: fileShareName, capacityGb }],
          networks: [{ network: "default", modes: ["MODE_IPV4"] }],
        }),
      },
    );
    if (!res.ok) throw new Error(`Filestore API ${res.status}: ${await res.text()}`);
    const now = ctx.now();
    const fullName = `projects/${p}/locations/${location}/instances/${name}`;
    return {
      id: ctx.id(accountId, "filestore-instance", fullName),
      pluginId: "gcp",
      resourceTypeId: "filestore-instance",
      accountId,
      displayName: name,
      fields: {
        name,
        location,
        tier,
        state: "CREATING",
        capacityGb,
        network: "default",
        fileShareName,
        ipAddress: "",
      },
      resolvedOutputs: { ipAddress: "" },
      secretStates: [],
      externalId: fullName,
      createdAt: now,
      updatedAt: now,
    };
  },
};
