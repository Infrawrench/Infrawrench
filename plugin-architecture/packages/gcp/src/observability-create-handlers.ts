import type { CreateResourceConfig, ResourceInstance } from "@infrawrench/plugin-base";
import type { GcpCreateContext } from "./create-context.js";

export const observabilityCreateConfigHandlers: Record<
  string,
  (ctx: GcpCreateContext, parentResourceId?: string) => Promise<CreateResourceConfig>
> = {
  "log-sink": async (ctx, parentResourceId) => {
    return {
      fields: [
        {
          key: "name",
          label: "Sink Name",
          kind: "text",
          required: true,
        },
        {
          key: "destination",
          label: "Destination",
          kind: "text",
          required: true,
          description:
            "e.g. storage.googleapis.com/my-bucket or bigquery.googleapis.com/projects/my-project/datasets/my-dataset",
        },
        {
          key: "filter",
          label: "Filter",
          kind: "text",
          required: false,
          description: "Optional log filter expression",
        },
      ],
    };
  },
  "alert-policy": async (ctx, parentResourceId) => {
    const p = ctx.project;
    const [descriptors, resourceDescriptors] = await Promise.all([
      ctx
        .paginate<{
          type?: string;
          displayName?: string;
        }>(
          `https://monitoring.googleapis.com/v3/projects/${p}/metricDescriptors`,
          "metricDescriptors",
          { pageSize: "1000" },
        )
        .catch(() => [] as Array<{ type?: string; displayName?: string }>),
      ctx
        .paginate<{
          type?: string;
          displayName?: string;
        }>(
          `https://monitoring.googleapis.com/v3/projects/${p}/monitoredResourceDescriptors`,
          "resourceDescriptors",
        )
        .catch(() => [] as Array<{ type?: string; displayName?: string }>),
    ]);

    const metricOptions = descriptors
      .filter(
        (d): d is { type: string; displayName?: string } =>
          typeof d.type === "string" && d.type.length > 0,
      )
      .map((d) => ({
        id: d.type,
        label: d.displayName?.trim() || d.type,
      }))
      .sort((a, b) => a.label.localeCompare(b.label));

    const resourceTypeOptions = resourceDescriptors
      .filter(
        (d): d is { type: string; displayName?: string } =>
          typeof d.type === "string" && d.type.length > 0,
      )
      .map((d) => ({
        id: d.type,
        label: d.displayName?.trim() ? `${d.displayName.trim()} (${d.type})` : d.type,
      }))
      .sort((a, b) => a.label.localeCompare(b.label));

    return {
      fields: [
        {
          key: "displayName",
          label: "Display Name",
          kind: "text",
          required: true,
        },
        {
          key: "conditionDisplayName",
          label: "Condition Name",
          kind: "text",
          required: true,
          description: "Display name for the alert condition",
        },
        {
          key: "metricType",
          label: "Metric Type",
          kind: "select",
          required: true,
          options: metricOptions,
          description: "e.g. compute.googleapis.com/instance/cpu/utilization",
        },
        {
          key: "resourceType",
          label: "Resource Type",
          kind: "select",
          required: true,
          options: resourceTypeOptions,
          defaultValue: "global",
          description: "Monitored resource that emits this metric (e.g. gce_instance, global)",
        },
        {
          key: "thresholdValue",
          label: "Threshold Value",
          kind: "number",
          required: true,
          defaultValue: "0.8",
          description: "Threshold at which to trigger the alert",
        },
        {
          key: "comparisonType",
          label: "Comparison",
          kind: "select",
          required: true,
          options: [
            { id: "COMPARISON_GT", label: "Greater than" },
            { id: "COMPARISON_LT", label: "Less than" },
            { id: "COMPARISON_GE", label: "Greater or equal" },
            { id: "COMPARISON_LE", label: "Less or equal" },
          ],
          defaultValue: "COMPARISON_GT",
        },
        {
          key: "duration",
          label: "Duration (seconds)",
          kind: "number",
          required: false,
          defaultValue: "60",
          description: "How long the condition must be true before alerting",
        },
      ],
    };
  },
};

export const observabilityCreateResourceHandlers: Record<
  string,
  (
    ctx: GcpCreateContext,
    accountId: string,
    fields: Record<string, string>,
    parentResourceId?: string,
  ) => Promise<ResourceInstance>
> = {
  "log-sink": async (ctx, accountId, fields, parentResourceId) => {
    const p = ctx.project;
    const tok = await ctx.token();
    const name = fields["name"] ?? "";
    const destination = fields["destination"] ?? "";
    const filter = fields["filter"] ?? "";

    const res = await fetch(`https://logging.googleapis.com/v2/projects/${p}/sinks`, {
      method: "POST",
      headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name, destination, filter }),
    });
    if (!res.ok) throw new Error(`Logging API ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as Record<string, unknown>;
    const now = ctx.now();
    return {
      id: ctx.id(accountId, "log-sink", name),
      pluginId: "gcp",
      resourceTypeId: "log-sink",
      accountId,
      displayName: name,
      fields: {
        name,
        destination,
        filter,
        disabled: false,
        writerIdentity: String(data["writerIdentity"] ?? ""),
      },
      resolvedOutputs: {},
      secretStates: [],
      externalId: name,
      createdAt: now,
      updatedAt: now,
    };
  },
  "alert-policy": async (ctx, accountId, fields, parentResourceId) => {
    const p = ctx.project;
    const tok = await ctx.token();
    const displayName = fields["displayName"] ?? "";
    const conditionDisplayName = fields["conditionDisplayName"] ?? "";
    const metricType = fields["metricType"] ?? "";
    const resourceType = fields["resourceType"] ?? "global";
    const thresholdValue = Number(fields["thresholdValue"] || 0.8);
    const comparisonType = fields["comparisonType"] ?? "COMPARISON_GT";
    const duration = fields["duration"] ?? "60";

    const res = await fetch(`https://monitoring.googleapis.com/v3/projects/${p}/alertPolicies`, {
      method: "POST",
      headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        displayName,
        combiner: "OR",
        conditions: [
          {
            displayName: conditionDisplayName,
            conditionThreshold: {
              filter: `metric.type="${metricType}" AND resource.type="${resourceType}"`,
              comparison: comparisonType,
              thresholdValue,
              duration: `${duration}s`,
            },
          },
        ],
      }),
    });
    if (!res.ok) throw new Error(`Monitoring API ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as Record<string, unknown>;
    const fullName = String(data["name"] ?? "");
    const now = ctx.now();
    return {
      id: ctx.id(accountId, "alert-policy", fullName),
      pluginId: "gcp",
      resourceTypeId: "alert-policy",
      accountId,
      displayName,
      fields: {
        name: fullName,
        displayName,
        enabled: true,
        conditionCount: 1,
        notificationChannelCount: 0,
        combiner: "OR",
      },
      resolvedOutputs: {},
      secretStates: [],
      externalId: fullName,
      createdAt: now,
      updatedAt: now,
    };
  },
};
