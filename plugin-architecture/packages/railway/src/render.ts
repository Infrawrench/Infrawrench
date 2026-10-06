import type {
  ActionNode,
  CreateFieldConfig,
  DetailViewSchema,
  ResourceInstance,
  ResourceStatus,
  ResourceTypeDefinition,
  SectionNode,
  SidebarItemSchema,
  TableColumn,
} from "@infrawrench/plugin-base";
import {
  joinSubtitle,
  labeledOutputItems,
  resourceTypeDisplayName,
} from "@infrawrench/plugin-base";
import { fieldItems, parseJson, pluginAction } from "./kit.js";

/** Detail-only data from `enrichDetail`, as JSON strings in `__` fields. */
export const ENRICH = {
  limits: "__limits",
  backups: "__backups",
  schedules: "__schedules",
  members: "__members",
  estimatedBill: "__estimatedBill",
} as const;

const IN_PROGRESS = new Set(["building", "deploying", "initializing", "queued", "waiting"]);
const FAILED = new Set(["failed", "crashed"]);

export function deploymentStatus(s: string): ResourceStatus {
  if (s === "success") return "healthy";
  if (IN_PROGRESS.has(s) || s === "removing") return "provisioning";
  if (FAILED.has(s)) return "error";
  if (s === "needs_approval" || s === "sleeping") return "degraded";
  return "info";
}

export function resourceStatus(resource: ResourceInstance): ResourceStatus {
  const f = resource.fields;
  switch (resource.resourceTypeId) {
    case "service":
      if (f["state"] === "none") return "info";
      if (f["state"] === "stopped") return "degraded";
      return deploymentStatus(String(f["status"] ?? ""));
    case "deployment":
      return deploymentStatus(String(f["status"] ?? ""));
    case "volume": {
      const s = String(f["state"] ?? "");
      if (s === "ready") return "healthy";
      if (s === "error") return "error";
      if (s === "deleted" || s === "deleting") return "degraded";
      return s ? "provisioning" : "info";
    }
    case "domain":
      if (f["kind"] === "custom" && f["verified"] === false) return "degraded";
      if (String(f["certificateStatus"] ?? "") === "issue_failed") return "error";
      return f["syncStatus"] === "active" || !f["syncStatus"] ? "healthy" : "provisioning";
    case "tcp-proxy":
      return f["syncStatus"] === "active" || !f["syncStatus"] ? "healthy" : "provisioning";
    case "workspace":
      return f["isOverLimit"] === true ? "error" : "healthy";
    default:
      return "info";
  }
}

function prompt(
  label: string,
  command: string,
  description: string,
  fields: CreateFieldConfig[],
  submitLabel: string,
  danger = false,
): ActionNode {
  return {
    kind: "action",
    label,
    action: {
      type: "prompt-nosql-command",
      command,
      title: label,
      description,
      fields,
      submitLabel,
      ...(danger ? { danger: true } : {}),
    },
    ...(danger ? { variant: "danger" as const } : {}),
  };
}

function serviceActions(f: ResourceInstance["fields"]): ActionNode[] {
  const actions: ActionNode[] = [];
  if (f["repo"]) {
    actions.push(
      pluginAction("Deploy Latest Commit", "deploy-latest", {
        success: "Deploy of the latest commit started.",
      }),
      prompt(
        "Deploy a Commit",
        "deployCommit",
        "Build and deploy one commit of the connected repository.",
        [{ key: "commitSha", label: "Commit SHA", kind: "text", required: true }],
        "Deploy",
      ),
    );
  }
  actions.push(
    pluginAction("Redeploy", "redeploy", {
      success: "Redeploy started from the current source and settings.",
    }),
  );
  if (f["latestDeploymentId"] && f["state"] === "running") {
    actions.push(
      pluginAction("Restart", "restart", {
        confirm: "Restart the running deployment's containers?",
        success: "Restart requested.",
      }),
    );
  }
  actions.push(
    prompt(
      "Scale",
      "scale",
      "Replicas per region, and the most CPU and memory one replica may use. Railway bills what is used, up to these limits.",
      [
        {
          key: "numReplicas",
          label: "Replicas",
          kind: "number",
          required: false,
          minValue: 1,
          defaultValue: f["numReplicas"] !== undefined ? String(f["numReplicas"]) : "1",
        },
        {
          key: "vcpus",
          label: "vCPU limit per replica",
          kind: "number",
          required: false,
          minValue: 0.5,
          stepValue: 0.5,
          defaultValue: f["vcpuLimit"] !== undefined ? String(f["vcpuLimit"]) : "",
        },
        {
          key: "memoryGB",
          label: "Memory limit per replica (GB)",
          kind: "number",
          required: false,
          minValue: 0.5,
          stepValue: 0.5,
          defaultValue: f["memoryLimitGb"] !== undefined ? String(f["memoryLimitGb"]) : "",
        },
      ],
      "Save",
    ),
    prompt(
      "Add TCP Proxy",
      "addTcpProxy",
      "Expose a port inside the service on a public host and port. The service is redeployed so the proxy takes effect.",
      [
        {
          key: "applicationPort",
          label: "Service port",
          kind: "number",
          required: true,
          minValue: 1,
          maxValue: 65535,
          placeholder: "5432",
        },
      ],
      "Add",
    ),
  );
  if (f["latestDeploymentId"] && f["state"] === "running") {
    actions.push(
      pluginAction("Stop", "stop", {
        confirm: "Stop the running deployment? The service serves nothing until you redeploy.",
        success: "Deployment stopped.",
        danger: true,
      }),
    );
  }
  return actions;
}

function deploymentActions(f: ResourceInstance["fields"]): ActionNode[] {
  const s = String(f["status"] ?? "");
  const actions: ActionNode[] = [];
  if (s === "needs_approval") {
    actions.push(pluginAction("Approve", "approve", { success: "Deployment approved." }));
  }
  if (IN_PROGRESS.has(s)) {
    actions.push(
      pluginAction("Cancel", "cancel", {
        confirm: "Cancel this deployment?",
        success: "Deployment canceled.",
        danger: true,
      }),
    );
  }
  if (f["canRollback"] === true) {
    actions.push(
      pluginAction("Roll Back to This", "rollback", {
        confirm: "Make this deployment live again, with the variables it was deployed with?",
        success: "Rollback started.",
      }),
    );
  }
  actions.push(pluginAction("Redeploy", "redeploy", { success: "Redeploy started." }));
  if (s === "success" && f["deploymentStopped"] !== true) {
    actions.push(
      pluginAction("Restart", "restart", { success: "Restart requested." }),
      pluginAction("Stop", "stop", {
        confirm: "Stop this deployment?",
        success: "Deployment stopped.",
        danger: true,
      }),
    );
  }
  return actions;
}

function volumeActions(f: ResourceInstance["fields"]): ActionNode[] {
  const backups = parseJson<Array<{ id: string; name?: string | null; createdAt?: string }>>(
    f[ENRICH.backups],
    [],
  );
  const schedules = parseJson<Array<{ kind: string }>>(f[ENRICH.schedules], []);
  const actions: ActionNode[] = [
    pluginAction("Back Up Now", "backup", { success: "Backup started." }),
    prompt(
      "Backup Schedule",
      "backupSchedule",
      "Automatic backups to keep. Leave all unticked to turn scheduled backups off.",
      [
        {
          key: "kinds",
          label: "Schedules",
          kind: "policy-picker",
          required: false,
          defaultValue: JSON.stringify(schedules.map((s) => s.kind)),
          policies: [
            { id: "DAILY", label: "Daily" },
            { id: "WEEKLY", label: "Weekly" },
            { id: "MONTHLY", label: "Monthly" },
          ],
        },
      ],
      "Save",
    ),
  ];
  if (backups.length > 0) {
    actions.push(
      prompt(
        "Restore Backup",
        "restoreBackup",
        "Overwrites the volume with the backup. The attached service is redeployed.",
        [
          {
            key: "backupId",
            label: "Backup",
            kind: "select",
            required: true,
            defaultValue: backups[0]!.id,
            options: backups.map((b) => ({
              id: b.id,
              label: [b.name, b.createdAt].filter(Boolean).join(" · ") || b.id,
            })),
          },
        ],
        "Restore",
        true,
      ),
    );
  }
  return actions;
}

function headerActions(resource: ResourceInstance): ActionNode[] {
  const f = resource.fields;
  let actions: ActionNode[] = [];
  switch (resource.resourceTypeId) {
    case "service":
      actions = serviceActions(f);
      break;
    case "deployment":
      actions = deploymentActions(f);
      break;
    case "volume":
      actions = volumeActions(f);
      break;
    case "domain":
      if (f["kind"] === "custom" && f["certificateStatus"] !== "valid") {
        actions.push(
          pluginAction("Retry Certificate", "issue-certificate", {
            success: "Certificate issuance requested.",
          }),
        );
      }
      break;
  }
  const url = consoleUrl(resource);
  if (url)
    actions.push({ kind: "action", label: "Open in Railway", action: { type: "open-url", url } });
  const live = String(f["url"] ?? "");
  if ((resource.resourceTypeId === "service" || resource.resourceTypeId === "deployment") && live) {
    actions.push({ kind: "action", label: "Open URL", action: { type: "open-url", url: live } });
  }
  actions.push({ kind: "action", label: "Refresh", action: { type: "refresh-resource" } });
  return actions;
}

export function consoleUrl(resource: ResourceInstance): string | null {
  const f = resource.fields;
  const project = String(
    f["projectId"] ?? (resource.resourceTypeId === "project" ? resource.externalId : ""),
  );
  if (!project) return null;
  const env = String(
    f["environmentId"] ?? (resource.resourceTypeId === "environment" ? resource.externalId : ""),
  );
  const base = `https://railway.com/project/${project}`;
  const service = String(f["serviceId"] ?? "");
  if (service) return `${base}/service/${service}${env ? `?environmentId=${env}` : ""}`;
  return env ? `${base}?environmentId=${env}` : base;
}

function table(
  title: string,
  columns: TableColumn[],
  rows: Array<Record<string, string>>,
): SectionNode | null {
  if (rows.length === 0) return null;
  return {
    kind: "section",
    title,
    children: [{ kind: "table", columns, rows: rows.map((cells) => ({ cells })) }],
  };
}

function enrichedSections(resource: ResourceInstance): SectionNode[] {
  const f = resource.fields;
  const out: Array<SectionNode | null> = [];
  const backups = parseJson<
    Array<{
      id: string;
      name?: string | null;
      createdAt?: string;
      expiresAt?: string | null;
      usedMB?: number | null;
    }>
  >(f[ENRICH.backups], []);
  out.push(
    table(
      "Backups",
      [
        { key: "created", label: "Created", mono: true },
        { key: "name", label: "Name" },
        { key: "size", label: "Size" },
        { key: "expires", label: "Expires" },
      ],
      backups.map((b) => ({
        created: b.createdAt ?? "",
        name: b.name ?? "",
        size: typeof b.usedMB === "number" ? `${b.usedMB} MB` : "",
        expires: b.expiresAt ?? "",
      })),
    ),
  );
  const schedules = parseJson<
    Array<{ kind: string; cron: string; retentionSeconds?: number | null }>
  >(f[ENRICH.schedules], []);
  out.push(
    table(
      "Backup Schedules",
      [
        { key: "kind", label: "Schedule" },
        { key: "cron", label: "Cron", mono: true },
        { key: "retention", label: "Kept For" },
      ],
      schedules.map((s) => ({
        kind: s.kind.toLowerCase(),
        cron: s.cron,
        retention: s.retentionSeconds ? `${Math.round(s.retentionSeconds / 86_400)} days` : "",
      })),
    ),
  );
  const members = parseJson<
    Array<{
      name?: string | null;
      email: string;
      role?: string;
      twoFactorAuthEnabled?: boolean | null;
    }>
  >(f[ENRICH.members], []);
  out.push(
    table(
      "Members",
      [
        { key: "name", label: "Name" },
        { key: "email", label: "Email" },
        { key: "role", label: "Role" },
        { key: "mfa", label: "2FA" },
      ],
      members.map((m) => ({
        name: m.name ?? "",
        email: m.email,
        role: (m.role ?? "").toLowerCase(),
        mfa: m.twoFactorAuthEnabled ? "On" : "Off",
      })),
    ),
  );
  const estimated = f[ENRICH.estimatedBill];
  if (typeof estimated === "string" && estimated) {
    out.push({
      kind: "section",
      title: "This Billing Period",
      children: [
        {
          kind: "key-value-list",
          items: [
            { key: "Projected usage at list price (USD)", value: estimated },
            ...(f["currentUsage"] !== undefined
              ? [{ key: "Usage so far (USD)", value: String(f["currentUsage"]) }]
              : []),
          ],
        },
      ],
    });
  }
  const limits = parseJson<Record<string, unknown> | null>(f[ENRICH.limits], null);
  if (limits && typeof limits === "object") {
    const items = flatten(limits).map(([key, value]) => ({ key, value }));
    if (items.length) {
      out.push({
        kind: "section",
        title: "Resource Limits",
        children: [{ kind: "key-value-list", items }],
      });
    }
  }
  return out.filter((s): s is SectionNode => s !== null);
}

function flatten(o: Record<string, unknown>, prefix = ""): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const [k, v] of Object.entries(o)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v))
      out.push(...flatten(v as Record<string, unknown>, key));
    else if (v !== null && v !== undefined) out.push([key, String(v)]);
  }
  return out;
}

const LOG_TYPES = new Set(["service", "deployment"]);

export function renderRailwayDetail(
  resource: ResourceInstance,
  resourceTypes: ResourceTypeDefinition[],
): DetailViewSchema {
  const f = resource.fields;
  const sections: SectionNode[] = [
    {
      kind: "section",
      title: "Details",
      children: [{ kind: "key-value-list", items: fieldItems(resource, resourceTypes) }],
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
  sections.push(...enrichedSections(resource));
  return {
    title: resource.displayName,
    subtitle: joinSubtitle(
      resourceTypeDisplayName(resourceTypes, resource.resourceTypeId),
      f["projectName"],
      f["environmentName"],
      f["region"],
    ),
    status: {
      kind: "status-dot",
      status: resourceStatus(resource),
      ...(f["status"] ? { label: String(f["status"]).replace(/_/g, " ") } : {}),
    },
    sections,
    headerActions: headerActions(resource),
    ...(LOG_TYPES.has(resource.resourceTypeId) ? { logs: { defaultTailLines: 200 } } : {}),
  };
}

export function renderRailwaySidebarItem(resource: ResourceInstance): SidebarItemSchema {
  return {
    id: resource.id,
    label: resource.displayName || resource.id,
    status: { kind: "status-dot", status: resourceStatus(resource) },
  };
}
