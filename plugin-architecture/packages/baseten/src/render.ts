import type {
  ActionNode,
  DetailViewSchema,
  KVItem,
  ResourceInstance,
  ResourceStatus,
  ResourceTypeDefinition,
  SectionNode,
  SidebarItemSchema,
} from "@infrawrench/plugin-base";
import {
  joinSubtitle,
  labeledOutputItems,
  resourceTypeDisplayName,
} from "@infrawrench/plugin-base";
import { ACTIVATED_STATUSES } from "./resource-types.js";

/**
 * Detail data that only `enrichDetail` fetches rides along in fields with a
 * `__` prefix (JSON strings), so it survives whatever serialisation sits
 * between enrichment and rendering. Those keys are never shown as fields.
 */
export const ENRICH_ENVIRONMENTS = "__environments";
export const ENRICH_DEPLOYMENTS = "__deployments";
export const ENRICH_DAILY = "__daily";

export interface DailyUsageRow {
  date: string;
  requests: number;
  minutes: number;
  cost: number;
}

function parseJson<T>(v: unknown, fallback: T): T {
  if (typeof v !== "string" || !v) return fallback;
  try {
    return JSON.parse(v) as T;
  } catch {
    return fallback;
  }
}

const FAILED_DEPLOYMENT = new Set(["DEPLOY_FAILED", "BUILD_FAILED", "FAILED", "BUILD_STOPPED"]);
const IN_PROGRESS_DEPLOYMENT = new Set([
  "BUILDING",
  "DEPLOYING",
  "LOADING_MODEL",
  "UPDATING",
  "WAKING_UP",
  "DEACTIVATING",
]);
const PROMOTION_IN_PROGRESS = new Set(["RELEASING", "RAMPING_UP", "RAMPING_DOWN", "PAUSED"]);
const LOG_TYPES = new Set(["deployment", "environment", "training-job"]);
const ACTIVE_TRAINING = new Set(["created", "pending", "deploying", "running"]);

export function deploymentStatus(status: string): ResourceStatus {
  if (status === "ACTIVE") return "healthy";
  if (status === "UNHEALTHY") return "degraded";
  if (status === "SCALED_TO_ZERO" || status === "INACTIVE") return "info";
  if (FAILED_DEPLOYMENT.has(status)) return "error";
  if (IN_PROGRESS_DEPLOYMENT.has(status)) return "provisioning";
  return "unknown";
}

export function resourceStatus(resource: ResourceInstance): ResourceStatus {
  const f = resource.fields;
  switch (resource.resourceTypeId) {
    case "deployment":
    case "environment":
      return f["status"] ? deploymentStatus(String(f["status"])) : "unknown";
    case "training-job": {
      const s = String(f["status"] ?? "");
      if (s === "running") return "healthy";
      if (s === "failed" || s === "deploy_failed") return "error";
      if (s === "preempted") return "degraded";
      if (ACTIVE_TRAINING.has(s)) return "provisioning";
      return "info";
    }
    case "training-project": {
      const s = String(f["latestJobStatus"] ?? "");
      if (s === "running") return "healthy";
      if (s === "failed" || s === "deploy_failed") return "error";
      return "info";
    }
    default:
      return "info";
  }
}

function action(
  label: string,
  actionId: string,
  opts: { confirm?: string; success: string; danger?: boolean; destructive?: boolean },
): ActionNode {
  return {
    kind: "action",
    label,
    action: {
      type: "plugin-action",
      actionId,
      ...(opts.confirm ? { confirmMessage: opts.confirm } : {}),
      successMessage: opts.success,
      ...(opts.destructive ? { destructive: true } : {}),
    },
    ...(opts.danger ? { variant: "danger" as const } : {}),
  };
}

function consoleUrl(resource: ResourceInstance): string | null {
  const f = resource.fields;
  switch (resource.resourceTypeId) {
    case "model":
      return `https://app.baseten.co/models/${resource.externalId}/overview`;
    case "deployment":
    case "environment":
      return f["modelId"] ? `https://app.baseten.co/models/${String(f["modelId"])}/overview` : null;
    case "chain":
      return `https://app.baseten.co/chains/${resource.externalId}/overview`;
    case "training-project":
    case "training-job":
      return "https://app.baseten.co/training";
    case "model-api":
      return "https://app.baseten.co/model-apis";
    case "secret":
      return "https://app.baseten.co/settings/secrets";
    default:
      return null;
  }
}

function deploymentActions(resource: ResourceInstance): ActionNode[] {
  const f = resource.fields;
  const status = String(f["status"] ?? "");
  const actions: ActionNode[] = [];
  const isProd = f["isProduction"] === true || f["isProduction"] === "true";
  const isDev = f["isDevelopment"] === true || f["isDevelopment"] === "true";
  if (status === "INACTIVE") {
    actions.push(
      action("Activate", "activate", {
        success: "Activation requested. Replicas start according to the autoscaling settings.",
      }),
    );
  } else if (ACTIVATED_STATUSES.includes(status)) {
    actions.push(
      action("Deactivate", "deactivate", {
        confirm:
          "Deactivate this deployment? Its replicas stop and requests to it fail until it is activated again.",
        success: "Deactivation requested.",
        danger: true,
      }),
    );
  }
  if (Number(f["minReplica"] ?? 0) > 0 && !isDev) {
    actions.push(
      action("Scale to zero when idle", "scale-to-zero", {
        confirm:
          "Set min replicas to 0? The deployment scales to zero after the scale-down delay and the next request waits for a cold start.",
        success: "Min replicas set to 0.",
      }),
    );
  }
  if (FAILED_DEPLOYMENT.has(status)) {
    actions.push(action("Retry", "retry", { success: "Retry requested." }));
  }
  if (!isProd) {
    actions.push(
      action("Promote to production", "promote", {
        confirm:
          "Promote this deployment to production? Production traffic moves to it and the previous production deployment is scaled down.",
        success: "Promotion started.",
      }),
    );
    const envs = parseJson<string[]>(f[ENRICH_ENVIRONMENTS], []).filter(
      (e) => e !== "production" && e !== String(f["environment"] ?? ""),
    );
    if (envs.length > 0) {
      actions.push({
        kind: "action",
        label: "Promote to environment",
        action: {
          type: "prompt-nosql-command",
          command: "promoteToEnvironment",
          title: "Promote to environment",
          description:
            "Moves the environment's traffic to this deployment. The environment keeps its own autoscaling settings.",
          fields: [
            {
              key: "environment",
              label: "Environment",
              kind: "select",
              required: true,
              defaultValue: envs[0]!,
              options: envs.map((e) => ({ id: e, label: e })),
            },
            {
              key: "scaleDownPrevious",
              label: "Scale down the previous deployment",
              kind: "select",
              required: true,
              defaultValue: "true",
              options: [
                { id: "true", label: "Yes" },
                { id: "false", label: "No, keep it running" },
              ],
            },
          ],
          submitLabel: "Promote",
        },
      });
    }
  }
  return actions;
}

function environmentActions(resource: ResourceInstance): ActionNode[] {
  const f = resource.fields;
  const status = String(f["status"] ?? "");
  const actions: ActionNode[] = [];
  if (status === "INACTIVE") {
    actions.push(action("Activate", "activate", { success: "Activation requested." }));
  } else if (ACTIVATED_STATUSES.includes(status)) {
    actions.push(
      action("Deactivate", "deactivate", {
        confirm:
          "Deactivate the deployment serving this environment? Requests to the environment fail until it is activated again.",
        success: "Deactivation requested.",
        danger: true,
      }),
    );
  }
  const promo = String(f["promotionStatus"] ?? "");
  if (PROMOTION_IN_PROGRESS.has(promo)) {
    if (promo === "PAUSED") {
      actions.push(
        action("Resume promotion", "resume-promotion", { success: "Promotion resumed." }),
      );
    } else {
      actions.push(action("Pause promotion", "pause-promotion", { success: "Promotion paused." }));
    }
    actions.push(
      action("Cancel promotion", "cancel-promotion", {
        confirm: "Cancel the promotion in progress? Traffic returns to the current deployment.",
        success: "Promotion canceled.",
        danger: true,
      }),
    );
  }
  const deployments = parseJson<Array<{ id: string; name: string }>>(
    f[ENRICH_DEPLOYMENTS],
    [],
  ).filter((d) => d.id !== String(f["currentDeploymentId"] ?? ""));
  if (deployments.length > 0 && !PROMOTION_IN_PROGRESS.has(promo)) {
    actions.push({
      kind: "action",
      label: "Promote a deployment",
      action: {
        type: "prompt-nosql-command",
        command: "promoteToEnvironment",
        title: "Promote a deployment",
        description: "Moves this environment's traffic to the chosen deployment.",
        fields: [
          {
            key: "deploymentId",
            label: "Deployment",
            kind: "select",
            required: true,
            defaultValue: deployments[0]!.id,
            options: deployments.map((d) => ({ id: d.id, label: d.name || d.id })),
          },
          {
            key: "scaleDownPrevious",
            label: "Scale down the previous deployment",
            kind: "select",
            required: true,
            defaultValue: "true",
            options: [
              { id: "true", label: "Yes" },
              { id: "false", label: "No, keep it running" },
            ],
          },
        ],
        submitLabel: "Promote",
      },
    });
  }
  return actions;
}

function headerActions(resource: ResourceInstance): ActionNode[] {
  let actions: ActionNode[] = [];
  if (resource.resourceTypeId === "deployment") actions = deploymentActions(resource);
  if (resource.resourceTypeId === "environment") actions = environmentActions(resource);
  if (resource.resourceTypeId === "training-job") {
    if (ACTIVE_TRAINING.has(String(resource.fields["status"] ?? ""))) {
      actions.push(
        action("Stop", "stop", {
          confirm: "Stop this training job? Progress since the last checkpoint is lost.",
          success: "Stop requested.",
          danger: true,
        }),
      );
    }
  }
  const url = consoleUrl(resource);
  if (url)
    actions.push({ kind: "action", label: "Open in Baseten", action: { type: "open-url", url } });
  actions.push({ kind: "action", label: "Refresh", action: { type: "refresh-resource" } });
  return actions;
}

function detailItems(
  resource: ResourceInstance,
  resourceTypes: ResourceTypeDefinition[],
): KVItem[] {
  const typeDef = resourceTypes.find((t) => t.id === resource.resourceTypeId);
  const items: KVItem[] = [];
  for (const def of typeDef?.fields ?? []) {
    if (def.kind === "password") continue;
    const v = resource.fields[def.key];
    if (v === undefined || v === "") continue;
    items.push({ key: def.label, value: typeof v === "boolean" ? (v ? "Yes" : "No") : String(v) });
  }
  return items;
}

function usageSection(resource: ResourceInstance): SectionNode | null {
  const rows = parseJson<DailyUsageRow[]>(resource.fields[ENRICH_DAILY], []);
  if (rows.length === 0) return null;
  return {
    kind: "section",
    title: "Billed usage by day",
    children: [
      {
        kind: "table",
        columns: [
          { key: "date", label: "Date", mono: true },
          { key: "requests", label: "Requests" },
          { key: "minutes", label: "Replica minutes" },
          { key: "cost", label: "Cost (USD)" },
        ],
        rows: rows.map((r) => ({
          cells: {
            date: r.date,
            requests: String(r.requests),
            minutes: String(r.minutes),
            cost: r.cost.toFixed(2),
          },
        })),
      },
    ],
  };
}

export function renderBasetenDetail(
  resource: ResourceInstance,
  resourceTypes: ResourceTypeDefinition[],
): DetailViewSchema {
  const f = resource.fields;
  const sections: SectionNode[] = [
    {
      kind: "section",
      title: "Details",
      children: [{ kind: "key-value-list", items: detailItems(resource, resourceTypes) }],
    },
  ];
  const outputs = labeledOutputItems(
    resource.resolvedOutputs,
    resourceTypes,
    resource.resourceTypeId,
  ).filter((i) => i.value !== "");
  if (outputs.length > 0) {
    sections.push({
      kind: "section",
      title: "Endpoints",
      children: [{ kind: "key-value-list", items: outputs.map((i) => ({ ...i, copyable: true })) }],
    });
  }
  if (resource.resourceTypeId === "deployment" && f["idle"] === "yes") {
    sections.push({
      kind: "section",
      title: "Idle replicas",
      children: [
        {
          kind: "text",
          variant: "muted",
          content:
            "This deployment keeps min replicas running but served no requests in the last 7 days. Scaling min replicas to 0 removes the always-on cost; the first request after idling waits for a cold start.",
        },
      ],
    });
  }
  const usage = usageSection(resource);
  if (usage) sections.push(usage);
  return {
    title: resource.displayName,
    subtitle: joinSubtitle(
      resourceTypeDisplayName(resourceTypes, resource.resourceTypeId),
      f["instanceType"],
      f["environment"] || undefined,
      f["teamName"],
    ),
    status: { kind: "status-dot", status: resourceStatus(resource) },
    sections,
    headerActions: headerActions(resource),
    ...(LOG_TYPES.has(resource.resourceTypeId) ? { logs: { defaultTailLines: 200 } } : {}),
  };
}

export function renderBasetenSidebarItem(resource: ResourceInstance): SidebarItemSchema {
  return {
    id: resource.id,
    label: resource.displayName,
    status: { kind: "status-dot", status: resourceStatus(resource) },
  };
}
