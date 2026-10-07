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
  formatBytes,
  joinSubtitle,
  labeledOutputItems,
  resourceTypeDisplayName,
} from "@infrawrench/plugin-base";
import { API_KEY_ROLE_LABELS, API_KEY_ROLES } from "./resource-types.js";

/**
 * Detail data that only `enrichDetail` fetches rides along in fields with a
 * `__` prefix (JSON strings). Those keys are never shown as fields.
 */
export const ENRICH_NAMESPACES = "__namespaces";
export const ENRICH_BACKUPS = "__backups";
export const ENRICH_SCHEDULES = "__schedules";
export const ENRICH_FILES = "__files";
export const ENRICH_HISTORY = "__history";
export const ENRICH_INDEXES = "__indexes";

/** Chat models the assistant chat endpoint accepts (`SearchCompletions.model`, 2026-07 spec). */
export const ASSISTANT_MODELS = [
  "gpt-4o",
  "gpt-4.1",
  "o4-mini",
  "claude-sonnet-4-5",
  "gemini-2.5-pro",
];

export interface NamespaceRow {
  name: string;
  records: number;
}

function parseJson<T>(v: unknown, fallback: T): T {
  if (typeof v !== "string" || !v) return fallback;
  try {
    return JSON.parse(v) as T;
  } catch {
    return fallback;
  }
}

const SIZE_FIELDS = new Set(["sizeBytes"]);

export function resourceStatus(resource: ResourceInstance): ResourceStatus {
  const f = resource.fields;
  const s = String(f["status"] ?? "");
  switch (resource.resourceTypeId) {
    case "index":
      if (s === "Ready") return f["readCapacityState"] === "Error" ? "degraded" : "healthy";
      if (s === "InitializationFailed" || s === "Failed") return "error";
      if (s === "Disabled") return "info";
      if (s) return "provisioning";
      return "unknown";
    case "collection":
    case "backup":
    case "assistant":
      if (s === "Ready") return "healthy";
      if (s === "InitializationFailed" || s === "Failed") return "error";
      if (s === "Terminated") return "info";
      if (s) return "provisioning";
      return "unknown";
    case "backup-schedule":
      return f["enabled"] === false || f["enabled"] === "false" ? "info" : "healthy";
    case "restore-job":
      if (s === "Completed") return "healthy";
      if (s === "Failed") return "error";
      if (s === "Pending") return "provisioning";
      return "info";
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

function consoleUrl(resource: ResourceInstance): string {
  switch (resource.resourceTypeId) {
    case "index":
    case "backup-schedule":
      return "https://app.pinecone.io/organizations/-/projects/-/indexes";
    case "backup":
    case "restore-job":
      return "https://app.pinecone.io/organizations/-/projects/-/backups";
    case "collection":
      return "https://app.pinecone.io/organizations/-/projects/-/collections";
    case "assistant":
      return "https://app.pinecone.io/organizations/-/projects/-/assistant";
    case "api-key":
      return "https://app.pinecone.io/organizations/-/projects/-/keys";
    case "project":
      return "https://app.pinecone.io/organizations/-/settings/projects";
    default:
      return "https://app.pinecone.io/organizations/-/settings/access";
  }
}

function indexActions(resource: ResourceInstance): ActionNode[] {
  const f = resource.fields;
  const actions: ActionNode[] = [];
  const deployment = String(f["deploymentType"] ?? "");
  const ready = f["status"] === "Ready";
  if (deployment !== "pod" && ready) {
    actions.push({
      kind: "action",
      label: "Back up now",
      action: {
        type: "prompt-nosql-command",
        command: "createBackup",
        title: "Back up index",
        description:
          "Takes an on-demand backup of the index. Backups are billed for storage until deleted.",
        fields: [
          {
            key: "name",
            label: "Backup name",
            kind: "text",
            required: false,
            placeholder: `${String(f["name"] ?? "index")}-backup`,
            description: "Lowercase letters, digits and hyphens, up to 45 characters",
          },
          { key: "description", label: "Description", kind: "text", required: false },
        ],
        submitLabel: "Create backup",
      },
    });
  }
  if (deployment === "pod" && ready) {
    actions.push({
      kind: "action",
      label: "Save as collection",
      action: {
        type: "prompt-nosql-command",
        command: "createCollection",
        title: "Save as collection",
        description: "Copies the index's records into a static collection.",
        fields: [
          {
            key: "name",
            label: "Collection name",
            kind: "text",
            required: true,
            placeholder: `${String(f["name"] ?? "index")}-snapshot`,
          },
        ],
        submitLabel: "Create collection",
      },
    });
  }
  if (f["deletionProtection"] === "enabled") {
    actions.push(
      action("Disable deletion protection", "disable-deletion-protection", {
        confirm: "Allow this index to be deleted?",
        success: "Deletion protection disabled.",
      }),
    );
  } else {
    actions.push(
      action("Enable deletion protection", "enable-deletion-protection", {
        success: "Deletion protection enabled.",
      }),
    );
  }
  if (f["readCapacityMode"] === "Dedicated") {
    actions.push(
      action("Switch to on-demand reads", "read-capacity-on-demand", {
        confirm:
          "Release the dedicated read nodes and bill reads per read unit instead? Query latency may change.",
        success: "Read capacity is switching to on-demand.",
      }),
    );
  }
  return actions;
}

function backupActions(resource: ResourceInstance): ActionNode[] {
  if (resource.fields["status"] !== "Ready") return [];
  const source = String(resource.fields["sourceIndexName"] ?? "index");
  return [
    {
      kind: "action",
      label: "Restore to new index",
      action: {
        type: "prompt-nosql-command",
        command: "restoreBackup",
        title: "Restore backup",
        description:
          "Creates a new serverless index from this backup. The source index is left untouched.",
        fields: [
          {
            key: "name",
            label: "New index name",
            kind: "text",
            required: true,
            placeholder: `${source}-restored`,
            description: "Lowercase letters, digits and hyphens, up to 45 characters",
          },
          {
            key: "deletionProtection",
            label: "Deletion protection",
            kind: "select",
            required: false,
            defaultValue: "disabled",
            options: [
              { id: "disabled", label: "Disabled" },
              { id: "enabled", label: "Enabled" },
            ],
          },
        ],
        submitLabel: "Restore",
      },
    },
  ];
}

function rotateActions(resource: ResourceInstance): ActionNode[] {
  if (resource.resourceTypeId !== "service-account") return [];
  return [
    action("Rotate client secret", "rotate-secret", {
      confirm:
        "Rotate this service account's client secret? The current secret stops working immediately.",
      success: "Secret rotated. The new secret is in the Client Secret output.",
      danger: true,
    }),
  ];
}

function headerActions(resource: ResourceInstance): ActionNode[] {
  let actions: ActionNode[] = [];
  switch (resource.resourceTypeId) {
    case "index":
      actions = indexActions(resource);
      break;
    case "backup":
      actions = backupActions(resource);
      break;
    case "service-account":
      actions = rotateActions(resource);
      break;
  }
  actions.push({
    kind: "action",
    label: "Open in Pinecone",
    action: { type: "open-url", url: consoleUrl(resource) },
  });
  actions.push({ kind: "action", label: "Refresh", action: { type: "refresh-resource" } });
  return actions;
}

function display(key: string, v: string | number | boolean): string {
  if (typeof v === "boolean") return v ? "Yes" : "No";
  if (SIZE_FIELDS.has(key) && typeof v === "number") return formatBytes(v);
  if (key === "roles" && typeof v === "string") {
    return v
      .split(",")
      .map((r) => r.trim())
      .filter(Boolean)
      .join(", ");
  }
  return String(v);
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
    items.push({ key: def.label, value: display(def.key, v) });
  }
  return items;
}

function table(
  title: string,
  columns: Array<{ key: string; label: string; mono?: boolean }>,
  rows: Array<Record<string, string>>,
): SectionNode {
  return {
    kind: "section",
    title,
    children: [
      {
        kind: "table",
        columns: columns.map((c) => ({
          key: c.key,
          label: c.label,
          ...(c.mono ? { mono: true } : {}),
        })),
        rows: rows.map((cells) => ({ cells })),
      },
    ],
  };
}

function enrichedSections(resource: ResourceInstance): SectionNode[] {
  const f = resource.fields;
  const out: SectionNode[] = [];
  const namespaces = parseJson<NamespaceRow[]>(f[ENRICH_NAMESPACES], []);
  if (namespaces.length) {
    out.push(
      table(
        "Namespaces",
        [
          { key: "name", label: "Namespace", mono: true },
          { key: "records", label: "Records" },
        ],
        namespaces.map((n) => ({ name: n.name || "(default)", records: String(n.records) })),
      ),
    );
  }
  const schedules = parseJson<Array<Record<string, string>>>(f[ENRICH_SCHEDULES], []);
  if (schedules.length) {
    out.push(
      table(
        "Backup schedules",
        [
          { key: "name", label: "Name" },
          { key: "frequency", label: "Frequency" },
          { key: "retention", label: "Retention (days)" },
          { key: "next", label: "Next run" },
        ],
        schedules,
      ),
    );
  }
  const backups = parseJson<Array<Record<string, string>>>(f[ENRICH_BACKUPS], []);
  if (backups.length) {
    out.push(
      table(
        "Backups",
        [
          { key: "name", label: "Name" },
          { key: "status", label: "Status" },
          { key: "records", label: "Records" },
          { key: "created", label: "Created", mono: true },
        ],
        backups,
      ),
    );
  }
  const history = parseJson<Array<Record<string, string>>>(f[ENRICH_HISTORY], []);
  if (history.length) {
    out.push(
      table(
        "Backups from this schedule",
        [
          { key: "name", label: "Name" },
          { key: "status", label: "Status" },
          { key: "size", label: "Size" },
          { key: "created", label: "Created", mono: true },
        ],
        history,
      ),
    );
  }
  const files = parseJson<Array<Record<string, string>>>(f[ENRICH_FILES], []);
  if (files.length) {
    out.push(
      table(
        "Files",
        [
          { key: "name", label: "File" },
          { key: "status", label: "Status" },
          { key: "size", label: "Size" },
          { key: "created", label: "Uploaded", mono: true },
        ],
        files,
      ),
    );
  }
  if (resource.resourceTypeId === "api-key") {
    const roles = String(f["roles"] ?? "")
      .split(",")
      .map((r) => r.trim())
      .filter(Boolean);
    if (roles.length) {
      out.push(
        table(
          "Roles",
          [
            { key: "role", label: "Role", mono: true },
            { key: "meaning", label: "Grants" },
          ],
          roles.map((r) => ({ role: r, meaning: API_KEY_ROLE_LABELS[r] ?? "" })),
        ),
      );
    }
  }
  return out;
}

function guidance(resource: ResourceInstance): SectionNode | null {
  const f = resource.fields;
  if (resource.resourceTypeId === "index" && f["readCapacityError"]) {
    return {
      kind: "section",
      title: "Read capacity problem",
      children: [{ kind: "text", variant: "muted", content: String(f["readCapacityError"]) }],
    };
  }
  if (resource.resourceTypeId === "index" && f["deploymentType"] === "pod") {
    return {
      kind: "section",
      title: "Pod-based index",
      children: [
        {
          kind: "text",
          variant: "muted",
          content:
            "Pod-based indexes can no longer be created with the current Pinecone API, but replicas and pod size can still be changed here. Pod size only scales up. To move to serverless, save a collection or migrate from the Pinecone console.",
        },
      ],
    };
  }
  if (resource.resourceTypeId === "backup" && f["sourceIndexDeletedAt"]) {
    return {
      kind: "section",
      title: "Source index deleted",
      children: [
        {
          kind: "text",
          variant: "muted",
          content: `The index this backup came from was deleted at ${String(f["sourceIndexDeletedAt"])}. The backup is still billed for storage; restore it or delete it.`,
        },
      ],
    };
  }
  if (resource.resourceTypeId === "api-key") {
    return {
      kind: "section",
      title: "Roles",
      children: [
        {
          kind: "text",
          variant: "muted",
          content: `Valid roles: ${API_KEY_ROLES.join(", ")}. Editing roles replaces the full set.`,
        },
      ],
    };
  }
  return null;
}

export function renderPineconeDetail(
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
      title: "Connection",
      children: [{ kind: "key-value-list", items: outputs.map((i) => ({ ...i, copyable: true })) }],
    });
  }
  const note = guidance(resource);
  if (note) sections.push(note);
  sections.push(...enrichedSections(resource));
  const isAssistantReady = resource.resourceTypeId === "assistant" && f["status"] === "Ready";
  return {
    title: resource.displayName,
    subtitle: joinSubtitle(
      resourceTypeDisplayName(resourceTypes, resource.resourceTypeId),
      f["deploymentType"] === "pod" ? f["podType"] : f["region"],
      f["kind"],
      f["projectName"],
    ),
    status: { kind: "status-dot", status: resourceStatus(resource) },
    sections,
    headerActions: headerActions(resource),
    ...(resource.resourceTypeId === "assistant"
      ? {
          chatPanel: {
            tabLabel: "Chat",
            subtitle: "Answers are grounded in the files uploaded to this assistant.",
            inputPlaceholder: "Ask the assistant…",
            ...(isAssistantReady ? {} : { disabledReason: "The assistant is not ready yet." }),
            models: ASSISTANT_MODELS,
            defaultModel: ASSISTANT_MODELS[0]!,
            modelLabel: "Model",
          },
        }
      : {}),
  };
}

export function renderPineconeSidebarItem(resource: ResourceInstance): SidebarItemSchema {
  return {
    id: resource.id,
    label: resource.displayName,
    status: { kind: "status-dot", status: resourceStatus(resource) },
  };
}

export function formatSize(bytes: unknown): string {
  const n = Number(bytes);
  return Number.isFinite(n) && n > 0 ? formatBytes(n) : "";
}
