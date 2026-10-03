import type { CreateResourceConfig, ResourceInstance } from "@infrawrench/plugin-base";
import { GCP_REGIONS } from "./regions.js";
import { VALKEY_ENGINE_VERSIONS } from "./resources/memorystore-valkey.js";
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
  "memorystore-valkey": async () => {
    return {
      fields: [
        {
          key: "name",
          label: "Instance ID",
          kind: "text",
          required: true,
          description: "4-63 lowercase letters, digits and hyphens, starting with a letter",
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
          key: "network",
          label: "VPC Network",
          kind: "resource-picker",
          required: true,
          description:
            "Network the instance's Private Service Connect endpoints are created in. It needs a service connection policy for Memorystore in this region",
          associationSources: [
            { pluginId: "gcp", resourceTypeId: "vpc-network", outputKey: "selfLink" },
          ],
        },
        {
          key: "mode",
          label: "Mode",
          kind: "select",
          required: true,
          options: [
            { id: "CLUSTER_DISABLED", label: "Cluster mode disabled (single shard)" },
            { id: "CLUSTER", label: "Cluster mode enabled (sharded)" },
          ],
          defaultValue: "CLUSTER_DISABLED",
        },
        {
          key: "shardCount",
          label: "Shards",
          kind: "number",
          required: true,
          defaultValue: "3",
          minValue: 1,
          maxValue: 250,
          showWhen: { fieldKey: "mode", fieldValue: "CLUSTER" },
        },
        {
          key: "replicaCount",
          label: "Replicas Per Shard",
          kind: "number",
          required: true,
          defaultValue: "1",
          minValue: 0,
          maxValue: 5,
        },
        {
          key: "nodeType",
          label: "Node Type",
          kind: "select",
          required: true,
          options: [
            { id: "SHARED_CORE_NANO", label: "shared-core-nano: 0.5 vCPU, 1.4 GB (dev/test only)" },
            { id: "CUSTOM_PICO", label: "custom-pico: 2 vCPU, 1.25 GB" },
            { id: "CUSTOM_MICRO", label: "custom-micro: 2 vCPU, 2.5 GB" },
            { id: "CUSTOM_MINI", label: "custom-mini: 2 vCPU, 3.75 GB" },
            { id: "STANDARD_SMALL", label: "standard-small: 2 vCPU, 6.5 GB" },
            { id: "HIGHMEM_MEDIUM", label: "highmem-medium: 2 vCPU, 13 GB" },
            { id: "HIGHCPU_MEDIUM", label: "highcpu-medium: 8 vCPU, 13 GB" },
            { id: "STANDARD_LARGE", label: "standard-large: 8 vCPU, 26 GB" },
            { id: "HIGHMEM_XLARGE", label: "highmem-xlarge: 8 vCPU, 58 GB" },
            { id: "HIGHMEM_2XLARGE", label: "highmem-2xlarge: 16 vCPU, 110 GB" },
          ],
          defaultValue: "HIGHMEM_MEDIUM",
        },
        {
          key: "engineVersion",
          label: "Valkey Version",
          kind: "select",
          required: true,
          options: VALKEY_ENGINE_VERSIONS.map((v) => ({
            id: v,
            label: `Valkey ${v.replace(/^VALKEY_/, "").replace("_", ".")}${v === "VALKEY_9_1" ? " (Preview)" : ""}`,
          })),
          defaultValue: "VALKEY_9_0",
        },
        {
          key: "authorizationMode",
          label: "Authentication",
          kind: "select",
          required: false,
          options: [
            { id: "AUTH_DISABLED", label: "Disabled" },
            { id: "IAM_AUTH", label: "IAM authentication" },
          ],
          defaultValue: "AUTH_DISABLED",
        },
        {
          key: "transitEncryptionMode",
          label: "In-transit Encryption",
          kind: "select",
          required: false,
          options: [
            { id: "TRANSIT_ENCRYPTION_DISABLED", label: "Disabled" },
            { id: "SERVER_AUTHENTICATION", label: "TLS (server authentication)" },
          ],
          defaultValue: "TRANSIT_ENCRYPTION_DISABLED",
        },
        {
          key: "deletionProtectionEnabled",
          label: "Deletion protection",
          kind: "select",
          required: false,
          options: [
            { id: "false", label: "Off" },
            { id: "true", label: "On" },
          ],
          defaultValue: "false",
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
  "memorystore-valkey": async (ctx, accountId, fields) => {
    const p = ctx.project;
    const tok = await ctx.token();
    const name = fields["name"] ?? "";
    const location = fields["location"] ?? "";
    const network = fields["network"] ?? "";
    if (!name || !location || !network) {
      throw new Error("Instance ID, region and VPC network are required");
    }
    // The picker hands over a selfLink; the API wants `projects/…/networks/…`.
    const idx = network.indexOf("projects/");
    const networkPath = idx >= 0 ? network.slice(idx) : `projects/${p}/global/networks/${network}`;
    const mode = fields["mode"] || "CLUSTER_DISABLED";
    const shardCount = mode === "CLUSTER" ? Number(fields["shardCount"] || 3) : 1;
    const replicaCount = Number(fields["replicaCount"] ?? 1);
    const nodeType = fields["nodeType"] || "HIGHMEM_MEDIUM";
    const engineVersion = fields["engineVersion"] || "VALKEY_9_0";
    const authorizationMode = fields["authorizationMode"] || "AUTH_DISABLED";
    const transitEncryptionMode = fields["transitEncryptionMode"] || "TRANSIT_ENCRYPTION_DISABLED";
    const deletionProtectionEnabled = fields["deletionProtectionEnabled"] === "true";

    const res = await fetch(
      `https://memorystore.googleapis.com/v1/projects/${p}/locations/${location}/instances?instanceId=${encodeURIComponent(name)}`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          mode,
          shardCount,
          replicaCount,
          nodeType,
          engineVersion,
          authorizationMode,
          transitEncryptionMode,
          deletionProtectionEnabled,
          endpoints: [
            { connections: [{ pscAutoConnection: { network: networkPath, projectId: p } }] },
          ],
        }),
      },
    );
    if (!res.ok) throw new Error(`Memorystore for Valkey API ${res.status}: ${await res.text()}`);
    const now = ctx.now();
    const fullName = `projects/${p}/locations/${location}/instances/${name}`;
    return {
      id: ctx.id(accountId, "memorystore-valkey", fullName),
      pluginId: "gcp",
      resourceTypeId: "memorystore-valkey",
      accountId,
      displayName: name,
      fields: {
        name,
        region: location,
        mode,
        nodeType,
        engineVersion,
        shardCount,
        replicaCount,
        deletionProtectionEnabled,
        state: "CREATING",
        authorizationMode,
        transitEncryptionMode,
        network: networkPath.split("/").pop() ?? "",
      },
      resolvedOutputs: { host: "", port: "", readerHost: "", valkeyUrl: "" },
      secretStates: [],
      externalId: fullName,
      createdAt: now,
      updatedAt: now,
    };
  },
};
