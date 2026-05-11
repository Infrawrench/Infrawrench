import type { CreateResourceConfig, ResourceInstance } from "@infrawrench/plugin-base";
import { regionOption } from "./regions.js";
import type { GcpCreateContext } from "./create-context.js";

export const bigtableCreateConfigHandlers: Record<
  string,
  (ctx: GcpCreateContext, parentResourceId?: string) => Promise<CreateResourceConfig>
> = {
  "bigtable-instance": async (ctx, parentResourceId) => {
    return {
      fields: [
        {
          key: "instanceId",
          label: "Instance ID",
          kind: "text",
          required: true,
        },
        {
          key: "displayName",
          label: "Display Name",
          kind: "text",
          required: true,
        },
        {
          key: "instanceType",
          label: "Instance Type",
          kind: "select",
          required: true,
          options: [
            { id: "PRODUCTION", label: "Production" },
            { id: "DEVELOPMENT", label: "Development" },
          ],
          defaultValue: "PRODUCTION",
        },
        {
          key: "clusterLocation",
          label: "Cluster Location",
          kind: "region-picker",
          required: true,
          regions: [
            regionOption("us-central1-b"),
            regionOption("us-east1-c"),
            regionOption("us-west1-b"),
            regionOption("europe-west1-b"),
            regionOption("asia-east1-a"),
          ],
          defaultValue: "us-central1-b",
        },
      ],
    };
  },
};

export const bigtableCreateResourceHandlers: Record<
  string,
  (
    ctx: GcpCreateContext,
    accountId: string,
    fields: Record<string, string>,
    parentResourceId?: string,
  ) => Promise<ResourceInstance>
> = {
  "bigtable-instance": async (ctx, accountId, fields, parentResourceId) => {
    const p = ctx.project;
    const tok = await ctx.token();
    const instanceId = fields["instanceId"] ?? "";
    const displayName = fields["displayName"] ?? "";
    const instanceType = fields["instanceType"] ?? "PRODUCTION";
    const clusterLocation = fields["clusterLocation"] ?? "us-central1-b";

    const clusterBody: Record<string, unknown> = {
      defaultStorageType: "SSD",
      location: `projects/${p}/locations/${clusterLocation}`,
    };
    if (instanceType === "PRODUCTION") {
      clusterBody.serveNodes = 3;
    }

    const res = await fetch(`https://bigtableadmin.googleapis.com/v2/projects/${p}/instances`, {
      method: "POST",
      headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        instanceId,
        instance: { displayName, type: instanceType },
        clusters: { [`${instanceId}-cluster`]: clusterBody },
      }),
    });
    if (!res.ok) throw new Error(`Bigtable API ${res.status}: ${await res.text()}`);
    const now = ctx.now();
    return {
      id: ctx.id(accountId, "bigtable-instance", instanceId),
      pluginId: "gcp",
      resourceTypeId: "bigtable-instance",
      accountId,
      displayName: displayName || instanceId,
      fields: {
        name: instanceId,
        displayName,
        type: instanceType,
        state: "CREATING",
      },
      resolvedOutputs: {},
      secretStates: [],
      externalId: instanceId,
      createdAt: now,
      updatedAt: now,
    };
  },
};
