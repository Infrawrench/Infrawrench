import type {
  CreateFieldConfig,
  CreateResourceConfig,
  RegionOption,
} from "@infrawrench/plugin-base";
import type { ConvexContext, CvDeployment, CvProject } from "./api.js";
import { enc, mgmt } from "./api.js";
import { DEPLOY_KEY_ACTIONS, USAGE_METRICS } from "./resource-types.js";

export interface CreateDeps {
  ctx: ConvexContext;
  teamId(): Promise<number>;
  projects(): Promise<CvProject[]>;
  deployments(): Promise<CvDeployment[]>;
}

const REGION_LOCATIONS: Record<string, [string, string]> = {
  "aws-us-east-1": ["US East (N. Virginia)", "\u{1F1FA}\u{1F1F8}"],
  "aws-eu-west-1": ["EU West (Ireland)", "\u{1F1EE}\u{1F1EA}"],
  "aws-ca-central-1": ["Canada (Central)", "\u{1F1E8}\u{1F1E6}"],
  "aws-ap-southeast-2": ["Asia Pacific (Sydney)", "\u{1F1E6}\u{1F1FA}"],
};

async function regionOptions(deps: CreateDeps): Promise<RegionOption[]> {
  const res = await mgmt<{
    items?: Array<{ name: string; displayName: string; available: boolean }>;
  }>(deps.ctx, "GET", `/teams/${enc(await deps.teamId())}/list_deployment_regions`);
  return (res?.items ?? [])
    .filter((r) => r.available)
    .map((r) => ({
      id: r.name,
      label: r.displayName || r.name,
      location: REGION_LOCATIONS[r.name]?.[0] ?? r.name,
      flag: REGION_LOCATIONS[r.name]?.[1] ?? "",
    }));
}

async function classOptions(deps: CreateDeps): Promise<Array<{ id: string; label: string }>> {
  const res = await mgmt<{ items?: Array<{ type: string; available: boolean }> }>(
    deps.ctx,
    "GET",
    `/teams/${enc(await deps.teamId())}/list_deployment_classes`,
  );
  return [
    { id: "", label: "Team default" },
    ...(res?.items ?? []).filter((c) => c.available).map((c) => ({ id: c.type, label: c.type })),
  ];
}

const TYPE_OPTIONS = [
  { id: "prod", label: "Production" },
  { id: "dev", label: "Development" },
  { id: "preview", label: "Preview" },
  { id: "custom", label: "Custom" },
];

async function projectPicker(deps: CreateDeps, parent?: string): Promise<CreateFieldConfig[]> {
  if (parent) return [];
  const projects = await deps.projects();
  const options = projects.map((p) => ({ id: String(p.id), label: p.name, description: p.slug }));
  return [
    {
      key: "projectId",
      label: "Project",
      kind: "select",
      required: true,
      options,
      ...(options[0] ? { defaultValue: options[0].id } : {}),
    },
  ];
}

async function deploymentPicker(deps: CreateDeps, parent?: string): Promise<CreateFieldConfig[]> {
  if (parent) return [];
  const [deployments, projects] = await Promise.all([deps.deployments(), deps.projects()]);
  const names = new Map(projects.map((p) => [p.id, p.name]));
  const options = deployments.map((d) => ({
    id: d.name,
    label: `${names.get(d.projectId) ?? d.projectId} / ${d.reference || d.name}`,
    description: `${d.deploymentType} · ${d.name}`,
  }));
  return [
    {
      key: "deploymentName",
      label: "Deployment",
      kind: "select",
      required: true,
      options,
      ...(options[0] ? { defaultValue: options[0].id } : {}),
    },
  ];
}

export async function getCreateConfig(
  deps: CreateDeps,
  typeId: string,
  parentResourceId?: string,
): Promise<CreateResourceConfig> {
  const parent = parentResourceId ? parentResourceId.split(":").slice(2).join(":") : undefined;
  switch (typeId) {
    case "convex-project": {
      const [regions, classes] = await Promise.all([regionOptions(deps), classOptions(deps)]);
      return {
        fields: [
          { key: "name", label: "Project Name", kind: "text", required: true },
          {
            key: "deploymentType",
            label: "Create a Deployment",
            kind: "select",
            required: false,
            options: [{ id: "", label: "No, just the project" }, ...TYPE_OPTIONS.slice(0, 2)],
            defaultValue: "prod",
          },
          {
            key: "region",
            label: "Region",
            kind: "region-picker",
            required: false,
            regions,
            ...(regions[0] ? { defaultValue: regions[0].id } : {}),
            showWhen: { fieldKey: "deploymentType", fieldValuesNot: [""] },
          },
          {
            key: "class",
            label: "Deployment Class",
            kind: "select",
            required: false,
            options: classes,
            defaultValue: "",
            showWhen: { fieldKey: "deploymentType", fieldValuesNot: [""] },
          },
        ],
      };
    }
    case "convex-deployment": {
      const [regions, classes] = await Promise.all([regionOptions(deps), classOptions(deps)]);
      return {
        fields: [
          ...(await projectPicker(deps, parent)),
          {
            key: "deploymentType",
            label: "Type",
            kind: "select",
            required: true,
            options: TYPE_OPTIONS,
            defaultValue: "dev",
          },
          {
            key: "reference",
            label: "Reference",
            kind: "text",
            required: false,
            placeholder: "staging",
            description: "A name unique within the project, used by the CLI's --deployment flag.",
          },
          {
            key: "region",
            label: "Region",
            kind: "region-picker",
            required: false,
            regions,
            ...(regions[0] ? { defaultValue: regions[0].id } : {}),
          },
          {
            key: "class",
            label: "Class",
            kind: "select",
            required: false,
            options: classes,
            defaultValue: "",
          },
          {
            key: "isDefault",
            label: "Default Production Deployment",
            kind: "select",
            required: false,
            options: [
              { id: "", label: "Leave as is" },
              { id: "true", label: "Yes" },
              { id: "false", label: "No" },
            ],
            defaultValue: "",
            showWhen: { fieldKey: "deploymentType", fieldValue: "prod" },
          },
          {
            key: "expiresAt",
            label: "Delete Automatically At",
            kind: "datetime",
            required: false,
            description: "Optional. Preview deployments expire by default.",
          },
        ],
      };
    }
    case "convex-env-var":
      return {
        fields: [
          ...(await deploymentPicker(deps, parent)),
          {
            key: "name",
            label: "Name",
            kind: "text",
            required: true,
            placeholder: "OPENAI_API_KEY",
          },
          { key: "value", label: "Value", kind: "password", required: true },
        ],
      };
    case "convex-default-env-var":
      return {
        fields: [
          ...(await projectPicker(deps, parent)),
          { key: "name", label: "Name", kind: "text", required: true },
          { key: "value", label: "Value", kind: "password", required: true },
          {
            key: "deploymentTypes",
            label: "Apply To",
            kind: "policy-picker",
            required: true,
            policies: TYPE_OPTIONS.map((t) => ({ id: t.id, label: t.label })),
            description: "New deployments of these types start with this variable.",
          },
        ],
      };
    case "convex-deploy-key":
      return {
        fields: [
          ...(await deploymentPicker(deps, parent)),
          {
            key: "name",
            label: "Name",
            kind: "text",
            required: true,
            placeholder: "github-actions",
          },
          {
            key: "allowedActions",
            label: "Allowed Actions",
            kind: "policy-picker",
            required: false,
            description: "Leave empty for a key with every permission on this deployment.",
            policies: DEPLOY_KEY_ACTIONS.map((a) => ({
              id: a,
              label: a.replace(/^deployment:/, ""),
              category: a.split(":")[1] ?? "",
            })),
          },
          { key: "expiresAt", label: "Expires At", kind: "datetime", required: false },
        ],
      };
    case "convex-preview-deploy-key":
      return {
        fields: [
          ...(await projectPicker(deps, parent)),
          {
            key: "name",
            label: "Name",
            kind: "text",
            required: true,
            placeholder: "vercel-previews",
          },
          { key: "expiresAt", label: "Expires At", kind: "datetime", required: false },
        ],
      };
    case "convex-custom-domain":
      return {
        fields: [
          ...(await deploymentPicker(deps, parent)),
          {
            key: "domain",
            label: "Domain",
            kind: "text",
            required: true,
            placeholder: "api.example.com",
          },
          {
            key: "requestDestination",
            label: "Serves",
            kind: "select",
            required: true,
            options: [
              { id: "convexCloud", label: "Client API (convex.cloud)" },
              { id: "convexSite", label: "HTTP actions (convex.site)" },
            ],
            defaultValue: "convexCloud",
            description:
              "Point a CNAME at the deployment afterwards; Convex verifies it automatically.",
          },
        ],
      };
    case "convex-log-stream": {
      const show = (...types: string[]) => ({ fieldKey: "streamType", fieldValues: types });
      return {
        fields: [
          ...(await deploymentPicker(deps, parent)),
          {
            key: "streamType",
            label: "Destination",
            kind: "select",
            required: true,
            options: [
              { id: "webhook", label: "Webhook" },
              { id: "datadog", label: "Datadog" },
              { id: "axiom", label: "Axiom" },
              { id: "sentry", label: "Sentry (exceptions)" },
              { id: "postHogLogs", label: "PostHog Logs" },
              { id: "postHogErrorTracking", label: "PostHog Error Tracking" },
            ],
            defaultValue: "webhook",
          },
          {
            key: "url",
            label: "Webhook URL",
            kind: "text",
            required: false,
            showWhen: show("webhook"),
          },
          {
            key: "format",
            label: "Format",
            kind: "select",
            required: false,
            options: [
              { id: "jsonl", label: "JSONL (one event per line)" },
              { id: "json", label: "JSON (array per request)" },
            ],
            defaultValue: "jsonl",
            showWhen: show("webhook"),
          },
          {
            key: "siteLocation",
            label: "Datadog Site",
            kind: "select",
            required: false,
            options: ["US1", "US3", "US5", "EU", "US1_FED", "AP1"].map((s) => ({
              id: s,
              label: s,
            })),
            defaultValue: "US1",
            showWhen: show("datadog"),
          },
          {
            key: "apiKey",
            label: "API Key or Token",
            kind: "password",
            required: false,
            showWhen: show("datadog", "axiom", "postHogLogs", "postHogErrorTracking"),
          },
          {
            key: "service",
            label: "Datadog Service",
            kind: "text",
            required: false,
            showWhen: show("datadog"),
          },
          {
            key: "tags",
            label: "Datadog Tags",
            kind: "string-list",
            required: false,
            showWhen: show("datadog"),
          },
          {
            key: "datasetName",
            label: "Axiom Dataset",
            kind: "text",
            required: false,
            showWhen: show("axiom"),
          },
          {
            key: "ingestUrl",
            label: "Axiom Ingest URL",
            kind: "text",
            required: false,
            showWhen: show("axiom"),
          },
          {
            key: "dsn",
            label: "Sentry DSN",
            kind: "password",
            required: false,
            showWhen: show("sentry"),
          },
          {
            key: "host",
            label: "PostHog Host",
            kind: "text",
            required: false,
            placeholder: "https://us.i.posthog.com",
            showWhen: show("postHogLogs", "postHogErrorTracking"),
          },
          {
            key: "topics",
            label: "Topics",
            kind: "policy-picker",
            required: false,
            description: "Leave empty to send every topic, including future ones.",
            policies: [
              "console",
              "function_execution",
              "exception",
              "audit_log",
              "verification",
              "scheduler_stats",
              "scheduled_job_lag",
              "current_storage_usage",
              "concurrency_stats",
              "storage_api_bandwidth",
              "ai_gateway_usage",
              "log_stream_egress",
              "custom_audit",
            ].map((t) => ({ id: t, label: t })),
            showWhen: show("webhook", "datadog", "axiom", "postHogLogs"),
          },
        ],
      };
    }
    case "convex-usage-limit":
      return {
        fields: [
          ...(await deploymentPicker(deps, parent)),
          {
            key: "metric",
            label: "Metric",
            kind: "select",
            required: true,
            options: USAGE_METRICS.map(([id, label]) => ({ id, label })),
            defaultValue: "functionCalls",
          },
          {
            key: "window",
            label: "Per",
            kind: "select",
            required: true,
            options: [
              { id: "month", label: "Calendar month" },
              { id: "day", label: "Calendar day (UTC)" },
            ],
            defaultValue: "month",
          },
          { key: "limit", label: "Limit", kind: "number", required: true, minValue: 1 },
          {
            key: "limitType",
            label: "When Crossed",
            kind: "select",
            required: true,
            options: [
              { id: "warning", label: "Warn" },
              { id: "disable", label: "Disable the deployment" },
            ],
            defaultValue: "warning",
          },
          {
            key: "enabled",
            label: "Enabled",
            kind: "select",
            required: true,
            options: [
              { id: "true", label: "Yes" },
              { id: "false", label: "No" },
            ],
            defaultValue: "true",
          },
        ],
      };
    case "convex-invite":
      return {
        fields: [
          { key: "email", label: "Email", kind: "text", required: true },
          {
            key: "role",
            label: "Role",
            kind: "select",
            required: true,
            options: [
              { id: "developer", label: "Developer" },
              { id: "admin", label: "Admin" },
            ],
            defaultValue: "developer",
          },
        ],
      };
    case "convex-custom-role":
      return {
        fields: [
          { key: "name", label: "Name", kind: "text", required: true },
          { key: "description", label: "Description", kind: "text", required: false },
          {
            key: "effect",
            label: "Effect",
            kind: "select",
            required: true,
            options: [
              { id: "allow", label: "Allow" },
              { id: "deny", label: "Deny" },
            ],
            defaultValue: "allow",
          },
          {
            key: "actions",
            label: "Permissions",
            kind: "policy-picker",
            required: true,
            policies: ROLE_ACTIONS.map((a) => ({
              id: a,
              label: a,
              category: a.split(":")[0] ?? "",
            })),
          },
          {
            key: "resource",
            label: "Applies To",
            kind: "text",
            required: true,
            defaultValue: "project:*",
            description:
              "Resource path: project:* for every project, project:slug=my-app for one, project:*:deployment:type=prod for production deployments.",
          },
        ],
      };
    default:
      throw new Error(`Convex plugin: no create form for "${typeId}".`);
  }
}

/** `RoleStatementAction` from the Management API document (2026-10). */
const ROLE_ACTIONS = [
  "project:create",
  "project:update",
  "project:delete",
  "project:view",
  "project:transfer",
  "project:updateMemberRole",
  "defaultEnvironmentVariable:view",
  "defaultEnvironmentVariable:create",
  "defaultEnvironmentVariable:update",
  "defaultEnvironmentVariable:delete",
  "deployment:view",
  "deployment:create",
  "deployment:delete",
  "deployment:transfer",
  "deployment:updateClass",
  "deployment:updateType",
  "deployment:updateIsDefault",
  "deployment:updateReference",
  "deployment:updateExpiresAt",
  "deployment:customDomain:view",
  "deployment:customDomain:create",
  "deployment:customDomain:delete",
  "deployment:token:view",
  "deployment:token:create",
  "deployment:token:delete",
  ...DEPLOY_KEY_ACTIONS,
  "member:view",
  "member:invite",
  "member:remove",
  "member:updateRole",
  "billing:view",
  "billing:invoices:view",
  "team:usage:view",
  "team:auditLog:view",
  "team:token:view",
  "team:token:create",
  "team:token:delete",
];
