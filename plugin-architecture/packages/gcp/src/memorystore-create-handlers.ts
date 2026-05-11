import type { CreateResourceConfig, ResourceInstance } from "@infrawrench/plugin-base";
import { GCP_REGIONS } from "./regions.js";
import type { GcpCreateContext } from "./create-context.js";

export const memorystoreCreateConfigHandlers: Record<
  string,
  (ctx: GcpCreateContext, parentResourceId?: string) => Promise<CreateResourceConfig>
> = {
  "memorystore-redis": async (ctx, parentResourceId) => {
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
          label: "Region",
          kind: "region-picker",
          required: true,
          regions: GCP_REGIONS,
          defaultValue: "us-central1",
        },
        {
          key: "tier",
          label: "Tier",
          kind: "select",
          required: true,
          options: [
            { id: "BASIC", label: "Basic" },
            { id: "STANDARD_HA", label: "Standard (HA)" },
          ],
          defaultValue: "BASIC",
        },
        {
          key: "memorySizeGb",
          label: "Memory (GB)",
          kind: "number",
          required: true,
          defaultValue: "1",
          minValue: 1,
          maxValue: 300,
        },
      ],
    };
  },
  "memorystore-memcached": async (ctx, parentResourceId) => {
    return {
      fields: [
        { key: "name", label: "Instance Name", kind: "text", required: true },
        {
          key: "location",
          label: "Region",
          kind: "region-picker",
          required: true,
          regions: GCP_REGIONS,
          defaultValue: "us-central1",
        },
        {
          key: "nodeCount",
          label: "Node Count",
          kind: "number",
          required: true,
          defaultValue: "1",
        },
        {
          key: "cpuCount",
          label: "vCPUs Per Node",
          kind: "number",
          required: true,
          defaultValue: "1",
        },
        {
          key: "memorySizeMb",
          label: "Memory Per Node (MB)",
          kind: "number",
          required: true,
          defaultValue: "1024",
        },
        {
          key: "memcacheVersion",
          label: "Memcached Version",
          kind: "select",
          required: false,
          options: [
            { id: "MEMCACHE_1_5", label: "1.5" },
            { id: "MEMCACHE_1_6_15", label: "1.6.15" },
          ],
          defaultValue: "MEMCACHE_1_5",
        },
      ],
    };
  },
};

export const memorystoreCreateResourceHandlers: Record<
  string,
  (
    ctx: GcpCreateContext,
    accountId: string,
    fields: Record<string, string>,
    parentResourceId?: string,
  ) => Promise<ResourceInstance>
> = {
  "memorystore-redis": async (ctx, accountId, fields, parentResourceId) => {
    const p = ctx.project;
    const tok = await ctx.token();
    const name = fields["name"] ?? "";
    const location = fields["location"] ?? "";
    const tier = fields["tier"] ?? "BASIC";
    const memorySizeGb = Number(fields["memorySizeGb"] || 1);

    const res = await fetch(
      `https://redis.googleapis.com/v1/projects/${p}/locations/${location}/instances?instanceId=${name}`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
        body: JSON.stringify({ tier, memorySizeGb }),
      },
    );
    if (!res.ok) throw new Error(`Memorystore Redis API ${res.status}: ${await res.text()}`);
    const now = ctx.now();
    const fullName = `projects/${p}/locations/${location}/instances/${name}`;
    return {
      id: ctx.id(accountId, "memorystore-redis", fullName),
      pluginId: "gcp",
      resourceTypeId: "memorystore-redis",
      accountId,
      displayName: name,
      fields: {
        name,
        region: location,
        tier,
        memorySizeGb,
        redisVersion: "",
        state: "CREATING",
      },
      resolvedOutputs: {
        host: "",
        port: "6379",
      },
      secretStates: [],
      externalId: fullName,
      createdAt: now,
      updatedAt: now,
    };
  },
  "memorystore-memcached": async (ctx, accountId, fields, parentResourceId) => {
    const p = ctx.project;
    const name = fields["name"] ?? "";
    const location = fields["location"] ?? "us-central1";
    const nodeCount = Number(fields["nodeCount"] ?? "1");
    const cpuCount = Number(fields["cpuCount"] ?? "1");
    const memorySizeMb = Number(fields["memorySizeMb"] ?? "1024");
    const memcacheVersion = fields["memcacheVersion"] ?? "MEMCACHE_1_5";
    const tok = await ctx.token();
    const res = await fetch(
      `https://memcache.googleapis.com/v1/projects/${p}/locations/${location}/instances?instanceId=${encodeURIComponent(name)}`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          nodeCount,
          nodeConfig: { cpuCount, memorySizeMb },
          memcacheVersion,
        }),
      },
    );
    if (!res.ok)
      throw new Error(`Memorystore Memcached create failed: ${res.status}: ${await res.text()}`);
    const now = new Date().toISOString();
    return {
      id: ctx.id(accountId, "memorystore-memcached", `${p}/${location}/${name}`),
      pluginId: "gcp",
      resourceTypeId: "memorystore-memcached",
      accountId,
      displayName: name,
      fields: {
        name,
        location,
        state: "CREATING",
        nodeCount,
        cpuCount,
        memorySizeMb,
        memcacheVersion,
        discoveryEndpoint: "",
      },
      resolvedOutputs: { discoveryEndpoint: "" },
      secretStates: [],
      externalId: `${p}/${location}/${name}`,
      createdAt: now,
      updatedAt: now,
    };
  },
};
