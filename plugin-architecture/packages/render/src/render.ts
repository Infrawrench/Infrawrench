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
import { LOG_FILTERS } from "./logs.js";

/**
 * Detail data that only `enrichDetail` fetches rides along in `__`-prefixed
 * fields as JSON strings; they are never shown as fields.
 */
export const ENRICH = {
  events: "__events",
  instances: "__instances",
  users: "__users",
  recovery: "__recovery",
  exports: "__exports",
  snapshots: "__snapshots",
  secretFiles: "__secretFiles",
  syncs: "__syncs",
  members: "__members",
  services: "__services",
} as const;

const DEPLOY_IN_PROGRESS = new Set([
  "created",
  "queued",
  "build_in_progress",
  "update_in_progress",
  "pre_deploy_in_progress",
]);
const DEPLOY_FAILED = new Set(["build_failed", "update_failed", "pre_deploy_failed"]);
const DB_PROVISIONING = new Set([
  "creating",
  "config_restart",
  "maintenance_in_progress",
  "recovery_in_progress",
  "updating_instance",
]);

export function resourceStatus(resource: ResourceInstance): ResourceStatus {
  const f = resource.fields;
  const s = String(f["status"] ?? f["state"] ?? f["verificationStatus"] ?? "");
  switch (resource.resourceTypeId) {
    case "service":
      return s === "suspended" ? "degraded" : "healthy";
    case "deploy":
      if (s === "live") return "healthy";
      if (DEPLOY_IN_PROGRESS.has(s)) return "provisioning";
      if (DEPLOY_FAILED.has(s)) return "error";
      return "info";
    case "postgres":
    case "key-value":
      if (s === "available") return "healthy";
      if (s === "suspended" || s === "maintenance_scheduled") return "degraded";
      if (s === "unavailable" || s === "recovery_failed") return "error";
      if (DB_PROVISIONING.has(s)) return "provisioning";
      return "unknown";
    case "custom-domain":
      return s === "verified" ? "healthy" : "degraded";
    case "job":
      if (s === "succeeded") return "healthy";
      if (s === "failed") return "error";
      if (s === "pending" || s === "running") return "provisioning";
      return "info";
    case "blueprint":
      if (s === "in_sync") return "healthy";
      if (s === "syncing" || s === "created") return "provisioning";
      if (s === "error") return "error";
      if (s === "paused") return "degraded";
      return "info";
    case "maintenance":
      if (s === "succeeded") return "healthy";
      if (s === "failed" || s === "user_fix_required") return "error";
      if (s === "in_progress") return "provisioning";
      if (s === "scheduled") return "degraded";
      return "info";
    default:
      return "info";
  }
}

function prompt(
  label: string,
  command: string,
  title: string,
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
      title,
      description,
      fields,
      submitLabel,
      ...(danger ? { danger: true } : {}),
    },
    ...(danger ? { variant: "danger" as const } : {}),
  };
}

const YES_NO = [
  { id: "true", label: "Yes" },
  { id: "false", label: "No" },
];

function serviceActions(resource: ResourceInstance): ActionNode[] {
  const f = resource.fields;
  const type = String(f["serviceType"] ?? "");
  const suspended = f["status"] === "suspended";
  const actions: ActionNode[] = [];
  if (suspended) {
    actions.push(
      pluginAction("Resume", "resume", {
        success: "Resume requested. Render redeploys the last successful deploy.",
      }),
    );
    return actions;
  }
  actions.push(
    pluginAction("Deploy", "deploy", { success: "Deploy of the latest commit started." }),
    pluginAction("Clear Cache and Deploy", "deploy-clear-cache", {
      success: "Deploy started with a cleared build cache.",
    }),
    prompt(
      "Deploy a Specific Version",
      "deployVersion",
      "Deploy a specific version",
      "Deploy one commit of the connected repository, or one image tag or digest for an image-backed service.",
      [
        {
          key: "commitId",
          label: "Commit SHA",
          kind: "text",
          required: false,
          placeholder: "a1b2c3d",
        },
        {
          key: "imageUrl",
          label: "Image URL",
          kind: "text",
          required: false,
          placeholder: "docker.io/acme/api:1.4.2",
        },
        {
          key: "clearCache",
          label: "Clear build cache",
          kind: "select",
          required: false,
          defaultValue: "false",
          options: YES_NO,
        },
      ],
      "Deploy",
    ),
  );
  if (type === "cron_job") {
    actions.push(
      pluginAction("Run Now", "run-cron", {
        confirm: "Run this cron job now? Any run in progress is canceled.",
        success: "Cron job run triggered.",
      }),
      pluginAction("Cancel Run", "cancel-cron", {
        confirm: "Cancel the cron job run in progress?",
        success: "Run canceled.",
      }),
    );
  }
  if (type !== "static_site" && type !== "cron_job") {
    actions.push(
      pluginAction("Restart", "restart", {
        confirm: "Restart every instance of this service?",
        success: "Restart requested.",
      }),
      prompt(
        "Scale",
        "scale",
        "Scale instances",
        f["autoscalingEnabled"] === true
          ? "Autoscaling is on, so Render ignores a fixed count until autoscaling is turned off."
          : "Run a fixed number of instances.",
        [
          {
            key: "numInstances",
            label: "Instances",
            kind: "number",
            required: true,
            minValue: 1,
            maxValue: 100,
            defaultValue: String(f["numInstances"] ?? 1),
          },
        ],
        "Scale",
      ),
      prompt(
        "Autoscaling",
        "autoscaling",
        "Autoscaling",
        "Scale between a minimum and maximum instance count on average CPU or memory. Requires a paid workspace plan.",
        [
          {
            key: "enabled",
            label: "Autoscaling",
            kind: "select",
            required: true,
            defaultValue: f["autoscalingEnabled"] === true ? "true" : "false",
            options: [
              { id: "true", label: "On" },
              { id: "false", label: "Off" },
            ],
          },
          {
            key: "min",
            label: "Minimum instances",
            kind: "number",
            required: true,
            minValue: 1,
            defaultValue: String(f["autoscalingMin"] ?? 1),
          },
          {
            key: "max",
            label: "Maximum instances",
            kind: "number",
            required: true,
            minValue: 1,
            defaultValue: String(f["autoscalingMax"] ?? 3),
          },
          {
            key: "cpuPercent",
            label: "Target CPU (%)",
            kind: "number",
            required: false,
            minValue: 1,
            maxValue: 90,
            defaultValue: String(f["autoscalingCpuPercent"] ?? 70),
            description: "Leave blank to not scale on CPU.",
          },
          {
            key: "memoryPercent",
            label: "Target memory (%)",
            kind: "number",
            required: false,
            minValue: 1,
            maxValue: 90,
            defaultValue: f["autoscalingMemoryPercent"]
              ? String(f["autoscalingMemoryPercent"])
              : "",
            description: "Leave blank to not scale on memory.",
          },
        ],
        "Save",
      ),
      prompt(
        "Run One-Off Job",
        "runJob",
        "Run a one-off job",
        "Runs a command on a copy of this service's latest successful build, with its environment.",
        [
          {
            key: "startCommand",
            label: "Command",
            kind: "text",
            required: true,
            placeholder: "npm run migrate",
          },
        ],
        "Run",
      ),
    );
  }
  if (type === "web_service") {
    actions.push(
      prompt(
        "Maintenance Mode",
        "maintenanceMode",
        "Maintenance mode",
        "Serve a maintenance page (or a URL of your own) instead of the service.",
        [
          {
            key: "enabled",
            label: "Maintenance mode",
            kind: "select",
            required: true,
            defaultValue: f["maintenanceMode"] === true ? "true" : "false",
            options: [
              { id: "true", label: "On" },
              { id: "false", label: "Off" },
            ],
          },
          {
            key: "uri",
            label: "Custom page URL",
            kind: "text",
            required: false,
            description: "Leave blank for Render's default maintenance page.",
          },
        ],
        "Save",
      ),
      pluginAction("Purge Edge Cache", "purge-cache", {
        confirm: "Purge every cached response for this service from Render's edge cache?",
        success: "Cache purge requested.",
        destructive: true,
      }),
    );
  }
  actions.push(
    pluginAction("Suspend", "suspend", {
      confirm:
        "Suspend this service? It stops serving and stops billing for compute until you resume it.",
      success: "Service suspended.",
      danger: true,
    }),
  );
  return actions;
}

function postgresActions(resource: ResourceInstance): ActionNode[] {
  const f = resource.fields;
  if (f["status"] === "suspended" || f["suspended"] === true) {
    return [pluginAction("Resume", "resume", { success: "Resume requested." })];
  }
  const actions: ActionNode[] = [
    pluginAction("Restart", "restart", {
      confirm: "Restart this database? Connections drop while it restarts.",
      success: "Restart requested.",
    }),
    pluginAction("Create Export", "export", {
      success: "Logical export started. It appears under Exports when it finishes.",
    }),
    prompt(
      "Point-in-Time Recovery",
      "recover",
      "Restore to a point in time",
      "Creates a new database from this one as it was at the chosen time. The original keeps running.",
      [
        {
          key: "restoreTime",
          label: "Restore to",
          kind: "datetime",
          required: true,
          datetimeMode: "datetime",
        },
        {
          key: "restoreName",
          label: "New database name",
          kind: "text",
          required: false,
          defaultValue: `${String(f["name"] ?? "db")}-restore`,
        },
      ],
      "Restore",
    ),
    prompt(
      "New Default User",
      "createUser",
      "Create a database user",
      "Creates a user that becomes the database's new default; connection strings switch to it.",
      [{ key: "username", label: "Username", kind: "text", required: true }],
      "Create",
    ),
    prompt(
      "Drop User",
      "deleteUser",
      "Drop a database user",
      "Drops a non-default user. Its open connections are closed.",
      [{ key: "username", label: "Username", kind: "text", required: true }],
      "Drop",
      true,
    ),
  ];
  if (f["highAvailabilityEnabled"] === true) {
    actions.push(
      pluginAction("Failover", "failover", {
        confirm: "Fail over to the standby? Connections drop for a few seconds.",
        success: "Failover started.",
      }),
    );
  }
  actions.push(
    pluginAction("Suspend", "suspend", {
      confirm: "Suspend this database? It stops accepting connections until you resume it.",
      success: "Database suspended.",
      danger: true,
    }),
  );
  return actions;
}

function headerActions(resource: ResourceInstance): ActionNode[] {
  const f = resource.fields;
  let actions: ActionNode[] = [];
  switch (resource.resourceTypeId) {
    case "service":
      actions = serviceActions(resource);
      break;
    case "deploy": {
      const status = String(f["status"] ?? "");
      if (DEPLOY_IN_PROGRESS.has(status)) {
        actions.push(
          pluginAction("Cancel", "cancel", {
            confirm: "Cancel this deploy?",
            success: "Deploy canceled.",
            danger: true,
          }),
        );
      } else if (status === "deactivated" || status === "live") {
        actions.push(
          pluginAction("Roll Back to This Deploy", "rollback", {
            confirm:
              "Redeploy this version? Automatic deploys stay on, so the next push replaces it again.",
            success: "Rollback started.",
          }),
        );
      }
      break;
    }
    case "custom-domain":
      if (f["verificationStatus"] !== "verified") {
        actions.push(
          pluginAction("Verify DNS", "verify", { success: "DNS verification requested." }),
        );
      }
      break;
    case "job":
      if (f["status"] === "pending" || f["status"] === "running") {
        actions.push(
          pluginAction("Cancel", "cancel", {
            confirm: "Cancel this job?",
            success: "Job canceled.",
            danger: true,
          }),
        );
      }
      break;
    case "postgres":
      actions = postgresActions(resource);
      break;
    case "key-value":
      actions.push(
        f["status"] === "suspended"
          ? pluginAction("Resume", "resume", { success: "Resume requested." })
          : pluginAction("Suspend", "suspend", {
              confirm: "Suspend this instance? It stops accepting connections until resumed.",
              success: "Instance suspended.",
              danger: true,
            }),
      );
      break;
    case "disk": {
      const snaps = parseJson<
        Array<{ snapshotKey?: string; createdAt?: string; instanceId?: string }>
      >(f[ENRICH.snapshots], []).filter((s) => s.snapshotKey);
      if (snaps.length > 0) {
        actions.push(
          prompt(
            "Restore Snapshot",
            "restoreSnapshot",
            "Restore a disk snapshot",
            "Overwrites the disk's current data with the snapshot. This cannot be undone and may trigger a deploy.",
            [
              {
                key: "snapshotKey",
                label: "Snapshot",
                kind: "select",
                required: true,
                defaultValue: snaps[0]!.snapshotKey!,
                options: snaps.map((s) => ({
                  id: s.snapshotKey!,
                  label: s.createdAt ?? s.snapshotKey!,
                })),
              },
            ],
            "Restore",
            true,
          ),
        );
      }
      break;
    }
    case "env-group": {
      const services = parseJson<Array<{ id: string; name: string }>>(f[ENRICH.services], []);
      const linked = new Set(
        String(f["linkedServiceIds"] ?? "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
      );
      const linkable = services.filter((s) => !linked.has(s.id));
      if (linkable.length > 0) {
        actions.push(
          prompt(
            "Link to Service",
            "linkService",
            "Link to a service",
            "The service gets this group's variables on its next deploy.",
            [
              {
                key: "serviceId",
                label: "Service",
                kind: "select",
                required: true,
                defaultValue: linkable[0]!.id,
                options: linkable.map((s) => ({ id: s.id, label: s.name })),
              },
            ],
            "Link",
          ),
        );
      }
      const linkedList = services.filter((s) => linked.has(s.id));
      if (linkedList.length > 0) {
        actions.push(
          prompt(
            "Unlink Service",
            "unlinkService",
            "Unlink a service",
            "The service loses this group's variables on its next deploy.",
            [
              {
                key: "serviceId",
                label: "Service",
                kind: "select",
                required: true,
                defaultValue: linkedList[0]!.id,
                options: linkedList.map((s) => ({ id: s.id, label: s.name })),
              },
            ],
            "Unlink",
            true,
          ),
        );
      }
      break;
    }
    case "maintenance":
      if (f["state"] === "scheduled") {
        actions.push(
          pluginAction("Run Now", "trigger", {
            confirm: "Start this maintenance now? The resource may restart.",
            success: "Maintenance started.",
          }),
        );
      }
      break;
  }
  const url = String(f["dashboardUrl"] ?? "");
  if (url)
    actions.push({ kind: "action", label: "Open in Render", action: { type: "open-url", url } });
  const live = String(f["url"] ?? "");
  if (resource.resourceTypeId === "service" && live) {
    actions.push({ kind: "action", label: "Open Site", action: { type: "open-url", url: live } });
  }
  actions.push({ kind: "action", label: "Refresh", action: { type: "refresh-resource" } });
  return actions;
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
  const events = parseJson<Array<{ timestamp?: string; type?: string }>>(f[ENRICH.events], []);
  out.push(
    table(
      "Recent Events",
      [
        { key: "time", label: "Time", mono: true },
        { key: "type", label: "Event" },
      ],
      events.map((e) => ({ time: e.timestamp ?? "", type: (e.type ?? "").replace(/_/g, " ") })),
    ),
  );
  const instances = parseJson<Array<{ id: string; createdAt?: string }>>(f[ENRICH.instances], []);
  out.push(
    table(
      "Instances",
      [
        { key: "id", label: "Instance", mono: true },
        { key: "created", label: "Started" },
      ],
      instances.map((i) => ({ id: i.id, created: i.createdAt ?? "" })),
    ),
  );
  const users = parseJson<
    Array<{ username?: string; default?: boolean; openConnections?: number; createdAt?: string }>
  >(f[ENRICH.users], []);
  out.push(
    table(
      "Database Users",
      [
        { key: "user", label: "User", mono: true },
        { key: "default", label: "Default" },
        { key: "connections", label: "Open Connections" },
        { key: "created", label: "Created" },
      ],
      users.map((u) => ({
        user: u.username ?? "",
        default: u.default ? "Yes" : "",
        connections: String(u.openConnections ?? 0),
        created: u.createdAt ?? "",
      })),
    ),
  );
  const recovery = parseJson<{ recoveryStatus?: string; startsAt?: string } | null>(
    f[ENRICH.recovery],
    null,
  );
  if (recovery?.recoveryStatus) {
    out.push({
      kind: "section",
      title: "Point-in-Time Recovery",
      children: [
        {
          kind: "key-value-list",
          items: [
            { key: "Status", value: recovery.recoveryStatus.replace(/_/g, " ").toLowerCase() },
            ...(recovery.startsAt
              ? [{ key: "Earliest Restore Point", value: recovery.startsAt }]
              : []),
          ],
        },
      ],
    });
  }
  const exports = parseJson<Array<{ id: string; createdAt?: string; url?: string }>>(
    f[ENRICH.exports],
    [],
  );
  if (exports.length > 0) {
    out.push({
      kind: "section",
      title: "Exports",
      children: exports.slice(0, 10).map((e) =>
        e.url
          ? {
              kind: "link" as const,
              label: `Download export from ${e.createdAt ?? e.id}`,
              url: e.url,
            }
          : {
              kind: "text" as const,
              content: `${e.createdAt ?? e.id} (preparing)`,
              variant: "muted" as const,
            },
      ),
    });
  }
  const snapshots = parseJson<Array<{ createdAt?: string; instanceId?: string }>>(
    f[ENRICH.snapshots],
    [],
  );
  out.push(
    table(
      "Snapshots",
      [
        { key: "created", label: "Taken", mono: true },
        { key: "instance", label: "Instance", mono: true },
      ],
      snapshots.map((s) => ({ created: s.createdAt ?? "", instance: s.instanceId ?? "" })),
    ),
  );
  const secretFiles = parseJson<string[]>(f[ENRICH.secretFiles], []);
  out.push(
    table(
      "Secret Files",
      [{ key: "name", label: "File", mono: true }],
      secretFiles.map((name) => ({ name })),
    ),
  );
  const syncs = parseJson<
    Array<{
      id: string;
      state?: string;
      startedAt?: string;
      completedAt?: string;
      commit?: { id?: string };
    }>
  >(f[ENRICH.syncs], []);
  out.push(
    table(
      "Recent Syncs",
      [
        { key: "started", label: "Started", mono: true },
        { key: "state", label: "State" },
        { key: "commit", label: "Commit", mono: true },
        { key: "completed", label: "Completed" },
      ],
      syncs.map((s) => ({
        started: s.startedAt ?? "",
        state: s.state ?? "",
        commit: (s.commit?.id ?? "").slice(0, 7),
        completed: s.completedAt ?? "",
      })),
    ),
  );
  const members = parseJson<
    Array<{ name?: string; email?: string; role?: string; status?: string; mfaEnabled?: boolean }>
  >(f[ENRICH.members], []);
  out.push(
    table(
      "Members",
      [
        { key: "name", label: "Name" },
        { key: "email", label: "Email" },
        { key: "role", label: "Role" },
        { key: "mfa", label: "2FA" },
        { key: "status", label: "Status" },
      ],
      members.map((m) => ({
        name: m.name ?? "",
        email: m.email ?? "",
        role: (m.role ?? "").toLowerCase().replace(/_/g, " "),
        mfa: m.mfaEnabled ? "On" : "Off",
        status: m.status ?? "",
      })),
    ),
  );
  return out.filter((s): s is SectionNode => s !== null);
}

const LOG_TYPES = new Set(["service", "job", "postgres", "key-value"]);

export function renderRenderDetail(
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
  const serviceType = String(f["serviceType"] ?? "").replace(/_/g, " ");
  const hasLogs =
    LOG_TYPES.has(resource.resourceTypeId) &&
    !(resource.resourceTypeId === "service" && f["serviceType"] === "static_site");
  return {
    title: resource.displayName,
    subtitle: joinSubtitle(
      resource.resourceTypeId === "service"
        ? serviceType
        : resourceTypeDisplayName(resourceTypes, resource.resourceTypeId),
      f["plan"],
      f["region"],
    ),
    status: {
      kind: "status-dot",
      status: resourceStatus(resource),
      ...(f["status"] ? { label: String(f["status"]).replace(/_/g, " ") } : {}),
    },
    sections,
    headerActions: headerActions(resource),
    ...(hasLogs ? { logs: { defaultTailLines: 200 } } : {}),
  };
}

export function renderRenderSidebarItem(resource: ResourceInstance): SidebarItemSchema {
  return {
    id: resource.id,
    label: resource.displayName || resource.id,
    status: { kind: "status-dot", status: resourceStatus(resource) },
  };
}

export { LOG_FILTERS };
