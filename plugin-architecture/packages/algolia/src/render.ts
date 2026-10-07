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
import { ACL_LABELS } from "./resource-types.js";

export const ENRICH_SOURCES = "__sources";
export const ENRICH_TOP_SEARCHES = "__topSearches";
export const ENRICH_NO_RESULTS = "__noResults";
export const ENRICH_INDEXES = "__indexNames";
export const ENRICH_CRAWL_STATS = "__crawlStats";

const BYTE_FIELDS = new Set(["dataSize", "fileSize"]);

function parseJson<T>(v: unknown, fallback: T): T {
  if (typeof v !== "string" || !v) return fallback;
  try {
    return JSON.parse(v) as T;
  } catch {
    return fallback;
  }
}

export function resourceStatus(resource: ResourceInstance): ResourceStatus {
  const s = String(resource.fields["status"] ?? "");
  switch (resource.resourceTypeId) {
    case "ab-test":
      if (s === "active") return "healthy";
      if (s === "failed") return "error";
      return "info";
    case "crawler":
      if (s === "blocked") return "error";
      if (s === "reindexing") return "provisioning";
      if (s === "running") return "healthy";
      return "info";
    case "api-key": {
      const exp = Date.parse(String(resource.fields["expiresAt"] ?? ""));
      return Number.isFinite(exp) && exp < Date.now() ? "error" : "healthy";
    }
    default:
      return "healthy";
  }
}

function action(
  label: string,
  actionId: string,
  opts: { confirm?: string; success: string; danger?: boolean },
): ActionNode {
  return {
    kind: "action",
    label,
    action: {
      type: "plugin-action",
      actionId,
      ...(opts.confirm ? { confirmMessage: opts.confirm } : {}),
      successMessage: opts.success,
    },
    ...(opts.danger ? { variant: "danger" as const } : {}),
  };
}

function indexActions(resource: ResourceInstance): ActionNode[] {
  const name = String(resource.fields["name"] ?? "");
  const others = parseJson<string[]>(resource.fields[ENRICH_INDEXES], []).filter((n) => n !== name);
  const out: ActionNode[] = [
    {
      kind: "action",
      label: "Copy index",
      action: {
        type: "prompt-nosql-command",
        command: "copyIndex",
        title: "Copy index",
        description:
          "Copies this index to another name. An existing destination is overwritten, but its replicas and analytics are kept.",
        fields: [
          {
            key: "destination",
            label: "Destination index",
            kind: "text",
            required: true,
            placeholder: `${name}_copy`,
          },
          {
            key: "scope",
            label: "What to copy",
            kind: "select",
            required: true,
            defaultValue: "all",
            options: [
              { id: "all", label: "Everything (records, settings, synonyms, rules)" },
              {
                id: "settings,synonyms,rules",
                label: "Configuration only (settings, synonyms, rules)",
              },
              { id: "settings", label: "Settings only" },
              { id: "synonyms", label: "Synonyms only" },
              { id: "rules", label: "Rules only" },
            ],
          },
        ],
        submitLabel: "Copy",
      },
    },
    {
      kind: "action",
      label: "Move into",
      action: {
        type: "prompt-nosql-command",
        command: "moveIndex",
        title: "Move index",
        description:
          "Moves this index onto another name (the usual way to swap in a freshly built index). This index disappears and the destination is replaced.",
        descriptionVariant: "error",
        fields: [
          {
            key: "destination",
            label: "Destination index",
            kind: "select",
            required: true,
            ...(others[0] ? { defaultValue: others[0] } : {}),
            options: others.map((o) => ({ id: o, label: o })),
          },
        ],
        submitLabel: "Move",
        danger: true,
      },
    },
    action("Clear records", "clear", {
      confirm: `Delete every record in ${name}? Settings, synonyms and rules are kept.`,
      success: "Clearing records.",
      danger: true,
    }),
  ];
  return out;
}

function headerActions(resource: ResourceInstance): ActionNode[] {
  const f = resource.fields;
  let out: ActionNode[] = [];
  switch (resource.resourceTypeId) {
    case "index":
      out = indexActions(resource);
      break;
    case "ab-test":
      if (f["status"] === "active") {
        out.push(
          action("Stop test", "stop", {
            confirm:
              "Stop this A/B test? All traffic returns to variant A and the test cannot be restarted.",
            success: "A/B test stopped.",
            danger: true,
          }),
        );
      }
      break;
    case "crawler":
      if (f["status"] === "paused")
        out.push(action("Resume", "run", { success: "Crawler resumed." }));
      else if (f["status"] !== "blocked") {
        out.push(
          action("Pause", "pause", { confirm: "Pause this crawler?", success: "Crawler paused." }),
        );
      }
      out.push(
        action("Recrawl now", "reindex", {
          confirm:
            "Start a full recrawl? Records are rebuilt into a temporary index and swapped in when done.",
          success: "Recrawl started.",
        }),
      );
      break;
  }
  const url =
    resource.resourceTypeId === "crawler"
      ? "https://dashboard.algolia.com/crawler"
      : "https://dashboard.algolia.com/";
  out.push({ kind: "action", label: "Open Algolia dashboard", action: { type: "open-url", url } });
  out.push({ kind: "action", label: "Refresh", action: { type: "refresh-resource" } });
  return out;
}

function detailItems(resource: ResourceInstance, types: ResourceTypeDefinition[]): KVItem[] {
  const def = types.find((t) => t.id === resource.resourceTypeId);
  const items: KVItem[] = [];
  for (const fd of def?.fields ?? []) {
    const v = resource.fields[fd.key];
    if (v === undefined || v === "") continue;
    let value: string;
    if (typeof v === "boolean") value = v ? "Yes" : "No";
    else if (BYTE_FIELDS.has(fd.key) && typeof v === "number") value = formatBytes(v);
    else value = String(v);
    items.push({ key: fd.label, value });
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

function extraSections(resource: ResourceInstance): SectionNode[] {
  const f = resource.fields;
  const out: SectionNode[] = [];
  const sources = parseJson<Array<Record<string, string>>>(f[ENRICH_SOURCES], []);
  if (sources.length) {
    out.push(
      table(
        "Allowed sources for the Admin API key",
        [
          { key: "source", label: "Source", mono: true },
          { key: "description", label: "Description" },
        ],
        sources,
      ),
    );
  }
  const top = parseJson<Array<Record<string, string>>>(f[ENRICH_TOP_SEARCHES], []);
  if (top.length) {
    out.push(
      table(
        "Top searches (last 7 days)",
        [
          { key: "search", label: "Query", mono: true },
          { key: "count", label: "Searches" },
          { key: "hits", label: "Avg. hits" },
        ],
        top,
      ),
    );
  }
  const none = parseJson<Array<Record<string, string>>>(f[ENRICH_NO_RESULTS], []);
  if (none.length) {
    out.push(
      table(
        "Searches with no results (last 7 days)",
        [
          { key: "search", label: "Query", mono: true },
          { key: "count", label: "Searches" },
        ],
        none,
      ),
    );
  }
  if (resource.resourceTypeId === "api-key") {
    const acl = String(f["acl"] ?? "")
      .split(",")
      .map((a) => a.trim())
      .filter(Boolean);
    if (acl.length) {
      out.push(
        table(
          "Permissions",
          [
            { key: "acl", label: "ACL", mono: true },
            { key: "meaning", label: "Allows" },
          ],
          acl.map((a) => ({ acl: a, meaning: ACL_LABELS[a] ?? "" })),
        ),
      );
    }
  }
  const crawl = parseJson<Array<Record<string, string>>>(f[ENRICH_CRAWL_STATS], []);
  if (crawl.length) {
    out.push(
      table(
        "Crawled URLs by outcome",
        [
          { key: "status", label: "Status" },
          { key: "reason", label: "Reason" },
          { key: "count", label: "URLs" },
        ],
        crawl,
      ),
    );
  }
  if (resource.resourceTypeId === "crawler" && f["blockingError"]) {
    out.push({
      kind: "section",
      title: "Crawler blocked",
      children: [{ kind: "text", variant: "muted", content: String(f["blockingError"]) }],
    });
  }
  return out;
}

export function renderAlgoliaDetail(
  resource: ResourceInstance,
  types: ResourceTypeDefinition[],
): DetailViewSchema {
  const f = resource.fields;
  const sections: SectionNode[] = [
    {
      kind: "section",
      title: "Details",
      children: [{ kind: "key-value-list", items: detailItems(resource, types) }],
    },
  ];
  const outputs = labeledOutputItems(
    resource.resolvedOutputs,
    types,
    resource.resourceTypeId,
  ).filter((i) => i.value !== "");
  if (outputs.length) {
    sections.push({
      kind: "section",
      title: "Connection",
      children: [{ kind: "key-value-list", items: outputs.map((i) => ({ ...i, copyable: true })) }],
    });
  }
  sections.push(...extraSections(resource));
  const isIndex = resource.resourceTypeId === "index";
  return {
    title: resource.displayName,
    subtitle: joinSubtitle(
      resourceTypeDisplayName(types, resource.resourceTypeId),
      f["role"],
      f["appId"],
      f["status"],
    ),
    status: { kind: "status-dot", status: resourceStatus(resource) },
    sections,
    headerActions: headerActions(resource),
    ...(isIndex || resource.resourceTypeId === "application"
      ? { logs: { defaultTailLines: 100 } }
      : {}),
    ...(isIndex
      ? { manifestEditor: { language: "json" as const, resourceKind: "Index settings" } }
      : {}),
  };
}

export function renderAlgoliaSidebarItem(resource: ResourceInstance): SidebarItemSchema {
  return {
    id: resource.id,
    label: resource.displayName,
    status: { kind: "status-dot", status: resourceStatus(resource) },
  };
}
