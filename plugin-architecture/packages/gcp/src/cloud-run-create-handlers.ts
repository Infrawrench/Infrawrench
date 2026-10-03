import type {
  RegionOption,
  CreateResourceConfig,
  ResourceInstance,
} from "@infrawrench/plugin-base";
import { GCP_REGIONS } from "./regions.js";
import type { GcpCreateContext } from "./create-context.js";
import { cloudRunJobToResource } from "./resource-listers/serverless.js";

/** Cloud Run's own region list, falling back to the static list if it can't be read. */
async function cloudRunRegionOptions(ctx: GcpCreateContext): Promise<RegionOption[]> {
  const regionsData = await ctx
    .get<{
      locations?: Array<{ locationId?: string; name?: string }>;
      items?: Array<{ name: string; status: string }>;
    }>(`https://run.googleapis.com/v2/projects/${ctx.project}/locations`)
    .catch(() => ({}) as { locations?: undefined; items?: undefined });
  const dynamicRegionIds = [
    ...(regionsData.locations ?? []).map((l) => l.locationId ?? l.name?.split("/").pop()),
    ...(regionsData.items ?? []).map((r) => r.name?.split("/").pop()),
  ].filter((id): id is string => !!id);
  return dynamicRegionIds.length > 0
    ? dynamicRegionIds.map((id) => GCP_REGIONS.find((r) => r.id === id) ?? { id, label: id })
    : GCP_REGIONS;
}

export const cloudRunCreateConfigHandlers: Record<
  string,
  (ctx: GcpCreateContext, parentResourceId?: string) => Promise<CreateResourceConfig>
> = {
  "cloud-run-service": async (ctx, parentResourceId) => {
    const regionOptions = await cloudRunRegionOptions(ctx);
    return {
      fields: [
        { key: "name", label: "Service Name", kind: "text", required: true },
        {
          key: "region",
          label: "Region",
          kind: "region-picker",
          required: true,
          regions: regionOptions,
          defaultValue: "us-central1",
        },
        {
          key: "image",
          label: "Container Image",
          kind: "text",
          required: true,
          description: "Container image URL (e.g. gcr.io/project/image:tag)",
        },
        {
          key: "port",
          label: "Container Port",
          kind: "number",
          required: false,
          defaultValue: "8080",
        },
        {
          key: "ingress",
          label: "Ingress",
          kind: "select",
          required: false,
          options: [
            { id: "INGRESS_TRAFFIC_ALL", label: "All traffic" },
            { id: "INGRESS_TRAFFIC_INTERNAL_ONLY", label: "Internal only" },
            { id: "INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER", label: "Internal load balancer" },
          ],
          defaultValue: "INGRESS_TRAFFIC_ALL",
        },
        {
          key: "network",
          label: "VPC Network",
          kind: "resource-picker",
          required: false,
          description: "VPC network for private service access",
          associationSources: [
            { pluginId: "gcp", resourceTypeId: "vpc-network", outputKey: "selfLink" },
          ],
        },
      ],
    };
  },
  "cloud-run-job": async (ctx) => {
    const regionOptions = await cloudRunRegionOptions(ctx);
    return {
      fields: [
        { key: "name", label: "Job Name", kind: "text", required: true },
        {
          key: "region",
          label: "Region",
          kind: "region-picker",
          required: true,
          regions: regionOptions,
          defaultValue: "us-central1",
        },
        {
          key: "image",
          label: "Container Image",
          kind: "text",
          required: true,
          description: "Container image URL, e.g. us-docker.pkg.dev/cloudrun/container/job:latest",
        },
        {
          key: "taskCount",
          label: "Tasks",
          kind: "number",
          required: false,
          defaultValue: "1",
          minValue: 1,
          maxValue: 10000,
          description: "Tasks per execution. Each gets CLOUD_RUN_TASK_INDEX in its environment",
        },
        {
          key: "parallelism",
          label: "Parallelism",
          kind: "number",
          required: false,
          defaultValue: "0",
          minValue: 0,
          description: "Maximum tasks running at once; 0 runs as many as possible",
        },
        {
          key: "maxRetries",
          label: "Max Retries",
          kind: "number",
          required: false,
          defaultValue: "3",
          minValue: 0,
          maxValue: 10,
        },
        {
          key: "timeoutSeconds",
          label: "Task Timeout (s)",
          kind: "number",
          required: false,
          defaultValue: "600",
          minValue: 1,
          maxValue: 604800,
        },
        {
          key: "memory",
          label: "Memory",
          kind: "select",
          required: false,
          options: ["512Mi", "1Gi", "2Gi", "4Gi", "8Gi", "16Gi", "32Gi"].map((m) => ({
            id: m,
            label: m.replace("Mi", " MiB").replace("Gi", " GiB"),
          })),
          defaultValue: "512Mi",
        },
        {
          key: "cpu",
          label: "CPU",
          kind: "select",
          required: false,
          options: ["1", "2", "4", "6", "8"].map((c) => ({ id: c, label: `${c} vCPU` })),
          defaultValue: "1",
        },
        {
          key: "serviceAccount",
          label: "Service Account",
          kind: "resource-picker",
          required: false,
          description: "Identity the tasks run as. Leave empty for the Compute Engine default",
          associationSources: [
            { pluginId: "gcp", resourceTypeId: "gcp-service-account", outputKey: "email" },
          ],
        },
      ],
    };
  },
};

export const cloudRunCreateResourceHandlers: Record<
  string,
  (
    ctx: GcpCreateContext,
    accountId: string,
    fields: Record<string, string>,
    parentResourceId?: string,
  ) => Promise<ResourceInstance>
> = {
  "cloud-run-service": async (ctx, accountId, fields, parentResourceId) => {
    const p = ctx.project;
    const name = fields["name"] ?? "";
    const region = fields["region"] ?? "us-central1";
    const image = fields["image"] ?? "";
    const port = Number(fields["port"] ?? "8080");
    const ingress = fields["ingress"] ?? "INGRESS_TRAFFIC_ALL";
    const network = fields["network"];
    const tok = await ctx.token();

    const template: Record<string, unknown> = {
      containers: [
        {
          image,
          ports: [{ containerPort: port }],
        },
      ],
    };

    if (network) {
      template.vpcAccess = {
        network: `projects/${p}/global/networks/${network}`,
      };
    }

    const res = await fetch(
      `https://run.googleapis.com/v2/projects/${p}/locations/${region}/services?serviceId=${encodeURIComponent(name)}`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
        body: JSON.stringify({ ingress, template }),
      },
    );
    if (!res.ok) throw new Error(`Cloud Run create failed: ${res.status}: ${await res.text()}`);
    const now = new Date().toISOString();
    // Use the full GCP service name so the resource ID matches what
    // listResources returns once the service is provisioned. Otherwise
    // getResource and getManifest will throw "not found" until the next sync.
    const fullName = `projects/${p}/locations/${region}/services/${name}`;
    return {
      id: ctx.id(accountId, "cloud-run-service", fullName),
      pluginId: "gcp",
      resourceTypeId: "cloud-run-service",
      accountId,
      displayName: name,
      fields: {
        name,
        region,
        latestRevision: "",
        state: "PROVISIONING",
        ingress,
      },
      resolvedOutputs: { url: "" },
      secretStates: [],
      externalId: fullName,
      createdAt: now,
      updatedAt: now,
    };
  },
  "cloud-run-job": async (ctx, accountId, fields) => {
    const p = ctx.project;
    const name = fields["name"] ?? "";
    const region = fields["region"] || "us-central1";
    const image = fields["image"] ?? "";
    if (!name || !image) throw new Error("Job name and container image are required");
    const taskCount = Number(fields["taskCount"] || 1);
    const parallelism = Number(fields["parallelism"] || 0);
    const maxRetries = Number(fields["maxRetries"] ?? 3);
    const timeoutSeconds = Number(fields["timeoutSeconds"] || 600);
    const serviceAccount = fields["serviceAccount"]?.trim();
    const tok = await ctx.token();

    const job = {
      template: {
        taskCount,
        parallelism,
        template: {
          containers: [
            {
              image,
              resources: {
                limits: { cpu: fields["cpu"] || "1", memory: fields["memory"] || "512Mi" },
              },
            },
          ],
          maxRetries,
          timeout: `${timeoutSeconds}s`,
          ...(serviceAccount ? { serviceAccount } : {}),
        },
      },
    };
    const res = await fetch(
      `https://run.googleapis.com/v2/projects/${p}/locations/${region}/jobs?jobId=${encodeURIComponent(name)}`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
        body: JSON.stringify(job),
      },
    );
    if (!res.ok) throw new Error(`Cloud Run job create failed: ${res.status}: ${await res.text()}`);
    const fullName = `projects/${p}/locations/${region}/jobs/${name}`;
    const created = cloudRunJobToResource(ctx, accountId, {
      ...job,
      name: fullName,
      reconciling: true,
    });
    return { ...created, createdAt: ctx.now(), updatedAt: ctx.now() };
  },
};
