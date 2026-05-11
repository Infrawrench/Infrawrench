import type { CreateResourceConfig, ResourceInstance } from "@infrawrench/plugin-base";
import { GCP_REGIONS } from "./regions.js";
import type { GcpCreateContext } from "./create-context.js";

export const alloydbCreateConfigHandlers: Record<
  string,
  (ctx: GcpCreateContext, parentResourceId?: string) => Promise<CreateResourceConfig>
> = {
  "alloydb-cluster": async (ctx, parentResourceId) => {
    return {
      fields: [
        {
          key: "clusterId",
          label: "Cluster ID",
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
          key: "network",
          label: "VPC Network",
          kind: "resource-picker",
          required: true,
          description: "VPC network for private service access",
          associationSources: [
            { pluginId: "gcp", resourceTypeId: "vpc-network", outputKey: "selfLink" },
          ],
        },
        {
          key: "rootPassword",
          label: "Postgres Password",
          kind: "password",
          required: true,
          description: "Password for the default 'postgres' user",
        },
      ],
    };
  },
  "alloydb-instance": async (ctx, parentResourceId) => {
    return {
      fields: [
        {
          key: "instanceId",
          label: "Instance ID",
          kind: "text",
          required: true,
        },
        {
          key: "instanceType",
          label: "Instance Type",
          kind: "select",
          required: true,
          options: [
            { id: "PRIMARY", label: "Primary" },
            { id: "READ_POOL", label: "Read pool" },
          ],
          defaultValue: "PRIMARY",
          description:
            "A cluster needs exactly one PRIMARY before it can be reached. Add READ_POOL instances for read scaling.",
        },
        {
          key: "cpuCount",
          label: "vCPU Count",
          kind: "select",
          required: true,
          options: [
            { id: "2", label: "2 vCPU" },
            { id: "4", label: "4 vCPU" },
            { id: "8", label: "8 vCPU" },
            { id: "16", label: "16 vCPU" },
            { id: "32", label: "32 vCPU" },
            { id: "64", label: "64 vCPU" },
          ],
          defaultValue: "2",
        },
      ],
    };
  },
};

export const alloydbCreateResourceHandlers: Record<
  string,
  (
    ctx: GcpCreateContext,
    accountId: string,
    fields: Record<string, string>,
    parentResourceId?: string,
  ) => Promise<ResourceInstance>
> = {
  "alloydb-cluster": async (ctx, accountId, fields, parentResourceId) => {
    const p = ctx.project;
    const tok = await ctx.token();
    const clusterId = fields["clusterId"] ?? "";
    const location = fields["location"] ?? "";
    const network = fields["network"] ?? "";
    const rootPassword = fields["rootPassword"] ?? "";
    const projectsIdx = network.indexOf("projects/");
    const networkPath =
      projectsIdx >= 0 ? network.slice(projectsIdx) : `projects/${p}/global/networks/${network}`;

    const res = await fetch(
      `https://alloydb.googleapis.com/v1/projects/${p}/locations/${location}/clusters?clusterId=${clusterId}`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          network: networkPath,
          initialUser: { user: "postgres", password: rootPassword },
        }),
      },
    );
    if (!res.ok) throw new Error(`AlloyDB API ${res.status}: ${await res.text()}`);
    const now = ctx.now();
    const fullName = `projects/${p}/locations/${location}/clusters/${clusterId}`;
    return {
      id: ctx.id(accountId, "alloydb-cluster", fullName),
      pluginId: "gcp",
      resourceTypeId: "alloydb-cluster",
      accountId,
      displayName: clusterId,
      fields: {
        name: clusterId,
        location,
        databaseVersion: "POSTGRES_14",
        state: "CREATING",
        clusterType: "",
      },
      resolvedOutputs: {},
      secretStates: [
        {
          fieldKey: "rootPassword",
          resolution: { kind: "plaintext", value: rootPassword },
        },
      ],
      externalId: fullName,
      createdAt: now,
      updatedAt: now,
    };
  },
  "alloydb-instance": async (ctx, accountId, fields, parentResourceId) => {
    const tok = await ctx.token();
    const instanceId = fields["instanceId"] ?? "";
    const instanceType = fields["instanceType"] || "PRIMARY";
    const cpuCount = Number.parseInt(fields["cpuCount"] ?? "2", 10) || 2;
    if (!parentResourceId) {
      throw new Error("AlloyDB instance creation requires a parent cluster");
    }
    // parentResourceId format: "{accountId}:alloydb-cluster:projects/{p}/locations/{l}/clusters/{c}"
    const clusterFullName = parentResourceId.split(":").slice(2).join(":");
    if (!clusterFullName.startsWith("projects/")) {
      throw new Error(`Invalid AlloyDB cluster reference: ${parentResourceId}`);
    }

    const res = await fetch(
      `https://alloydb.googleapis.com/v1/${clusterFullName}/instances?instanceId=${instanceId}`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          instanceType,
          machineConfig: { cpuCount },
        }),
      },
    );
    if (!res.ok) throw new Error(`AlloyDB API ${res.status}: ${await res.text()}`);
    const now = ctx.now();
    const fullName = `${clusterFullName}/instances/${instanceId}`;
    return {
      id: ctx.id(accountId, "alloydb-instance", fullName),
      pluginId: "gcp",
      resourceTypeId: "alloydb-instance",
      accountId,
      parentResourceId,
      displayName: instanceId,
      fields: {
        name: instanceId,
        instanceType,
        state: "CREATING",
        cpuCount,
        ipAddress: "",
        availabilityType: "",
      },
      resolvedOutputs: { ipAddress: "" },
      secretStates: [],
      externalId: fullName,
      createdAt: now,
      updatedAt: now,
    };
  },
};
