import type { CreateResourceConfig, ResourceInstance } from "@infrawrench/plugin-base";
import type { GcpCreateContext } from "./create-context.js";

export const cloudArmorCreateConfigHandlers: Record<
  string,
  (ctx: GcpCreateContext, parentResourceId?: string) => Promise<CreateResourceConfig>
> = {
  "cloud-armor-policy": async (ctx, parentResourceId) => {
    return {
      fields: [
        { key: "name", label: "Policy Name", kind: "text", required: true },
        {
          key: "description",
          label: "Description",
          kind: "text",
          required: false,
        },
        {
          key: "type",
          label: "Policy Type",
          kind: "select",
          required: false,
          options: [
            { id: "CLOUD_ARMOR", label: "Cloud Armor" },
            { id: "CLOUD_ARMOR_EDGE", label: "Cloud Armor Edge" },
            { id: "CLOUD_ARMOR_NETWORK", label: "Cloud Armor Network" },
          ],
          defaultValue: "CLOUD_ARMOR",
        },
      ],
    };
  },
};

export const cloudArmorCreateResourceHandlers: Record<
  string,
  (
    ctx: GcpCreateContext,
    accountId: string,
    fields: Record<string, string>,
    parentResourceId?: string,
  ) => Promise<ResourceInstance>
> = {
  "cloud-armor-policy": async (ctx, accountId, fields, parentResourceId) => {
    const p = ctx.project;
    const name = fields["name"] ?? "";
    const description = fields["description"] ?? "";
    const type = fields["type"] ?? "CLOUD_ARMOR";
    const tok = await ctx.token();
    const res = await fetch(
      `https://compute.googleapis.com/compute/v1/projects/${p}/global/securityPolicies`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
        body: JSON.stringify({ name, description, type }),
      },
    );
    if (!res.ok) throw new Error(`Cloud Armor create failed: ${res.status}: ${await res.text()}`);
    const now = new Date().toISOString();
    return {
      id: ctx.id(accountId, "cloud-armor-policy", `${p}/${name}`),
      pluginId: "gcp",
      resourceTypeId: "cloud-armor-policy",
      accountId,
      displayName: name,
      fields: { name, description, type, ruleCount: 0 },
      resolvedOutputs: {},
      secretStates: [],
      externalId: `${p}/${name}`,
      createdAt: now,
      updatedAt: now,
    };
  },
};
