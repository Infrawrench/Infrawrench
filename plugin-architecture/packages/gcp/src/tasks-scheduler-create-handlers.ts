import type { CreateResourceConfig, ResourceInstance } from "@infrawrench/plugin-base";
import { GCP_REGIONS } from "./regions.js";
import type { GcpCreateContext } from "./create-context.js";

export const tasksSchedulerCreateConfigHandlers: Record<
  string,
  (ctx: GcpCreateContext, parentResourceId?: string) => Promise<CreateResourceConfig>
> = {
  "cloud-tasks-queue": async (ctx, parentResourceId) => {
    return {
      fields: [
        {
          key: "name",
          label: "Queue Name",
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
      ],
    };
  },
  "cloud-scheduler-job": async (ctx, parentResourceId) => {
    return {
      fields: [
        {
          key: "name",
          label: "Job Name",
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
          key: "schedule",
          label: "Schedule (cron)",
          kind: "text",
          required: true,
          description: "Cron expression (e.g. */5 * * * *)",
        },
        {
          key: "timeZone",
          label: "Time Zone",
          kind: "select",
          required: false,
          description: "IANA time zone (e.g. America/New_York)",
          options: Intl.supportedValuesOf("timeZone").map((tz) => ({ id: tz, label: tz })),
          defaultValue: "UTC",
        },
        {
          key: "httpUri",
          label: "HTTP Target URI",
          kind: "text",
          required: true,
          description: "The URL that will be called on schedule",
        },
        {
          key: "httpMethod",
          label: "HTTP Method",
          kind: "select",
          required: false,
          options: [
            { id: "POST", label: "POST" },
            { id: "GET", label: "GET" },
            { id: "PUT", label: "PUT" },
            { id: "DELETE", label: "DELETE" },
          ],
          defaultValue: "POST",
        },
      ],
    };
  },
  workflow: async (ctx, parentResourceId) => {
    return {
      fields: [
        { key: "name", label: "Workflow Name", kind: "text", required: true },
        {
          key: "region",
          label: "Region",
          kind: "region-picker",
          required: true,
          regions: GCP_REGIONS,
          defaultValue: "us-central1",
        },
        {
          key: "sourceContents",
          label: "Workflow Definition (YAML)",
          kind: "text",
          required: true,
          description: "Workflow definition in YAML format",
        },
      ],
    };
  },
};

export const tasksSchedulerCreateResourceHandlers: Record<
  string,
  (
    ctx: GcpCreateContext,
    accountId: string,
    fields: Record<string, string>,
    parentResourceId?: string,
  ) => Promise<ResourceInstance>
> = {
  "cloud-tasks-queue": async (ctx, accountId, fields, parentResourceId) => {
    const p = ctx.project;
    const tok = await ctx.token();
    const name = fields["name"] ?? "";
    const location = fields["location"] ?? "";

    const res = await fetch(
      `https://cloudtasks.googleapis.com/v2/projects/${p}/locations/${location}/queues`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          name: `projects/${p}/locations/${location}/queues/${name}`,
        }),
      },
    );
    if (!res.ok) throw new Error(`Cloud Tasks API ${res.status}: ${await res.text()}`);
    const now = ctx.now();
    const fullName = `projects/${p}/locations/${location}/queues/${name}`;
    return {
      id: ctx.id(accountId, "cloud-tasks-queue", fullName),
      pluginId: "gcp",
      resourceTypeId: "cloud-tasks-queue",
      accountId,
      displayName: name,
      fields: {
        name,
        region: location,
        state: "RUNNING",
        maxDispatchesPerSecond: 0,
        maxConcurrentDispatches: 0,
        maxAttempts: 0,
      },
      resolvedOutputs: {},
      secretStates: [],
      externalId: fullName,
      createdAt: now,
      updatedAt: now,
    };
  },
  "cloud-scheduler-job": async (ctx, accountId, fields, parentResourceId) => {
    const p = ctx.project;
    const tok = await ctx.token();
    const name = fields["name"] ?? "";
    const location = fields["location"] ?? "";
    const schedule = fields["schedule"] ?? "";
    const timeZone = fields["timeZone"] ?? "UTC";
    const httpUri = fields["httpUri"] ?? "";
    const httpMethod = fields["httpMethod"] ?? "POST";

    const res = await fetch(
      `https://cloudscheduler.googleapis.com/v1/projects/${p}/locations/${location}/jobs`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          name: `projects/${p}/locations/${location}/jobs/${name}`,
          schedule,
          timeZone,
          httpTarget: { uri: httpUri, httpMethod },
        }),
      },
    );
    if (!res.ok) throw new Error(`Cloud Scheduler API ${res.status}: ${await res.text()}`);
    const now = ctx.now();
    const fullName = `projects/${p}/locations/${location}/jobs/${name}`;
    return {
      id: ctx.id(accountId, "cloud-scheduler-job", fullName),
      pluginId: "gcp",
      resourceTypeId: "cloud-scheduler-job",
      accountId,
      displayName: name,
      fields: {
        name,
        region: location,
        schedule,
        timeZone,
        state: "ENABLED",
        targetType: "HTTP",
        targetUri: httpUri,
        lastAttemptTime: "",
        scheduleTime: "",
      },
      resolvedOutputs: {},
      secretStates: [],
      externalId: fullName,
      createdAt: now,
      updatedAt: now,
    };
  },
  workflow: async (ctx, accountId, fields, parentResourceId) => {
    const p = ctx.project;
    const name = fields["name"] ?? "";
    const region = fields["region"] ?? "us-central1";
    const sourceContents = fields["sourceContents"] ?? "";
    const tok = await ctx.token();
    const res = await fetch(
      `https://workflows.googleapis.com/v1/projects/${p}/locations/${region}/workflows?workflowId=${encodeURIComponent(name)}`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
        body: JSON.stringify({ sourceContents }),
      },
    );
    if (!res.ok) throw new Error(`Workflow create failed: ${res.status}: ${await res.text()}`);
    const fullName = `projects/${p}/locations/${region}/workflows/${name}`;
    const now = new Date().toISOString();
    return {
      id: ctx.id(accountId, "workflow", fullName),
      pluginId: "gcp",
      resourceTypeId: "workflow",
      accountId,
      displayName: name,
      fields: { name, region, state: "ACTIVE", revisionId: "", serviceAccount: "" },
      resolvedOutputs: {},
      secretStates: [],
      externalId: fullName,
      createdAt: now,
      updatedAt: now,
    };
  },
};
