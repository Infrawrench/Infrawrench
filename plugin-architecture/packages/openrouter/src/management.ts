/**
 * Org-administration objects behind the management key: guardrails,
 * workspaces (with their budgets) and BYOK provider credentials. Wire shapes,
 * mapping, request bodies, create forms and detail views live here so the
 * client only routes.
 *
 * Spec: https://openrouter.ai/docs/api/api-reference (guardrails, workspaces, byok)
 */
import type {
  CreateResourceConfig,
  DetailViewSchema,
  KVItem,
  PolicyOption,
  ResourceInstance,
  SectionNode,
  SelectOption,
} from "@infrawrench/plugin-base";

const DASH = "—";

// ---------------------------------------------------------------- API shapes

export interface OrGuardrail {
  id: string;
  name: string;
  description?: string | null;
  workspace_id?: string | null;
  limit_usd?: number | null;
  reset_interval?: "daily" | "weekly" | "monthly" | null;
  include_byok_in_budgets?: boolean;
  allowed_providers?: string[] | null;
  ignored_providers?: string[] | null;
  allowed_models?: string[] | null;
  ignored_models?: string[] | null;
  allowed_data_regions?: string[] | null;
  content_filters?: unknown[] | null;
  content_filter_builtins?: Array<{ slug?: string; action?: string }> | null;
  enforce_zdr?: boolean | null;
  enable_paid_model_training?: boolean | null;
  enable_free_model_training?: boolean | null;
  enable_free_model_publication?: boolean | null;
  created_at?: string;
  updated_at?: string | null;
}

export interface OrGuardrailKeyAssignment {
  key_hash: string;
  key_name?: string;
  key_label?: string;
}

export interface OrWorkspace {
  id: string;
  name: string;
  slug?: string;
  description?: string | null;
  default_text_model?: string | null;
  default_image_model?: string | null;
  default_provider_sort?: string | null;
  default_guardrail_id?: string | null;
  include_byok_in_budgets?: boolean;
  io_logging_sampling_rate?: number;
  is_observability_io_logging_enabled?: boolean;
  is_observability_broadcast_enabled?: boolean;
  is_data_discount_logging_enabled?: boolean;
  created_at?: string;
  updated_at?: string | null;
}

export interface OrWorkspaceBudget {
  id?: string;
  limit_usd: number;
  /** `null` is the one-time "lifetime" budget. */
  reset_interval?: "daily" | "weekly" | "monthly" | null;
}

export interface OrByokCredential {
  id: string;
  provider: string;
  label?: string;
  name?: string | null;
  workspace_id?: string | null;
  disabled?: boolean;
  is_fallback?: boolean;
  is_byok_only?: boolean;
  is_required?: boolean;
  declared_zdr?: boolean | null;
  allowed_models?: string[] | null;
  allowed_api_key_hashes?: string[] | null;
  sort_order?: number;
  created_at?: string;
}

/** Workspace budget intervals, as the `{interval}` path segment takes them. */
export const BUDGET_INTERVALS = ["daily", "weekly", "monthly", "lifetime"] as const;
export type BudgetInterval = (typeof BUDGET_INTERVALS)[number];

/** `allowed_data_regions` values on a guardrail. */
const DATA_REGIONS: PolicyOption[] = [
  { id: "global", label: "Global" },
  { id: "us", label: "United States" },
  { id: "europe", label: "Europe" },
];

const RESET_OPTIONS: SelectOption[] = [
  { id: "never", label: "Never (lifetime limit)" },
  { id: "daily", label: "Daily" },
  { id: "weekly", label: "Weekly" },
  { id: "monthly", label: "Monthly" },
];

const PROVIDER_SORT_OPTIONS: SelectOption[] = [
  { id: "default", label: "OpenRouter default (load balanced)" },
  { id: "price", label: "Lowest price" },
  { id: "throughput", label: "Highest throughput" },
  { id: "latency", label: "Lowest latency" },
  { id: "exacto", label: "Exacto (tool-calling quality)" },
];

const YES_NO: SelectOption[] = [
  { id: "false", label: "No" },
  { id: "true", label: "Yes" },
];

// -------------------------------------------------------------------- mapping

function join(list: string[] | null | undefined): string {
  return (list ?? []).join(", ");
}

/** Comma list from an edit form or a JSON array from a multi-select picker. */
export function parseList(raw: string | undefined): string[] {
  if (!raw) return [];
  const trimmed = raw.trim();
  if (trimmed.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return parsed.map(String).filter(Boolean);
    } catch {
      // fall through to comma splitting
    }
  }
  return trimmed
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function base(
  accountId: string,
  typeId: string,
  id: string,
  displayName: string,
  createdAt: string | undefined,
  updatedAt: string | null | undefined,
): Omit<ResourceInstance, "fields"> {
  const now = new Date().toISOString();
  return {
    id: `${accountId}:${typeId}:${id}`,
    pluginId: "openrouter",
    resourceTypeId: typeId,
    accountId,
    displayName,
    externalId: id,
    resolvedOutputs: {},
    secretStates: [],
    createdAt: createdAt || now,
    updatedAt: updatedAt || createdAt || now,
  };
}

export function mapGuardrail(
  accountId: string,
  g: OrGuardrail,
  assignments?: OrGuardrailKeyAssignment[],
): ResourceInstance {
  return {
    ...base(accountId, "guardrail", g.id, g.name || g.id, g.created_at, g.updated_at),
    fields: {
      name: g.name ?? "",
      guardrailId: g.id,
      description: g.description ?? "",
      workspaceId: g.workspace_id ?? "",
      limitUsd: g.limit_usd ?? 0,
      resetInterval: g.reset_interval ?? "never",
      includeByokInBudgets: g.include_byok_in_budgets === true,
      allowedProviders: join(g.allowed_providers),
      ignoredProviders: join(g.ignored_providers),
      allowedModels: join(g.allowed_models),
      ignoredModels: join(g.ignored_models),
      allowedDataRegions: join(g.allowed_data_regions),
      enforceZdr: g.enforce_zdr === true,
      enablePaidModelTraining: g.enable_paid_model_training === true,
      enableFreeModelTraining: g.enable_free_model_training === true,
      enableFreeModelPublication: g.enable_free_model_publication === true,
      contentFilters: (g.content_filters?.length ?? 0) + (g.content_filter_builtins?.length ?? 0),
      ...(assignments
        ? {
            assignedKeys: assignments
              .map((a) => a.key_name || a.key_label || a.key_hash)
              .join(", "),
          }
        : {}),
      createdAt: g.created_at ?? "",
      updatedAt: g.updated_at ?? "",
    },
    resolvedOutputs: {
      guardrailId: g.id,
      ...(assignments ? { __keyAssignments__: JSON.stringify(assignments) } : {}),
      ...(g.content_filter_builtins?.length
        ? { __builtinFilters__: JSON.stringify(g.content_filter_builtins) }
        : {}),
    },
  };
}

export function mapWorkspace(
  accountId: string,
  w: OrWorkspace,
  budgets?: { data?: OrWorkspaceBudget[]; include_byok_in_budgets?: boolean },
  memberCount?: number,
): ResourceInstance {
  const budget = (interval: BudgetInterval): number => {
    const match = (budgets?.data ?? []).find((b) => (b.reset_interval ?? "lifetime") === interval);
    return match?.limit_usd ?? 0;
  };
  return {
    ...base(accountId, "workspace", w.id, w.name || w.slug || w.id, w.created_at, w.updated_at),
    fields: {
      name: w.name ?? "",
      workspaceId: w.id,
      slug: w.slug ?? "",
      description: w.description ?? "",
      defaultTextModel: w.default_text_model ?? "",
      defaultImageModel: w.default_image_model ?? "",
      defaultProviderSort: w.default_provider_sort || "default",
      defaultGuardrailId: w.default_guardrail_id ?? "",
      ...(budgets
        ? {
            budgetDaily: budget("daily"),
            budgetWeekly: budget("weekly"),
            budgetMonthly: budget("monthly"),
            budgetLifetime: budget("lifetime"),
          }
        : {}),
      includeByokInBudgets:
        (budgets?.include_byok_in_budgets ?? w.include_byok_in_budgets) === true,
      ioLoggingEnabled: w.is_observability_io_logging_enabled === true,
      ioLoggingSamplingRate: w.io_logging_sampling_rate ?? 0,
      broadcastEnabled: w.is_observability_broadcast_enabled === true,
      dataDiscountLoggingEnabled: w.is_data_discount_logging_enabled === true,
      ...(memberCount !== undefined ? { memberCount } : {}),
      createdAt: w.created_at ?? "",
      updatedAt: w.updated_at ?? "",
    },
    resolvedOutputs: { workspaceId: w.id, slug: w.slug ?? "" },
  };
}

export function mapByok(accountId: string, b: OrByokCredential): ResourceInstance {
  const display = b.name || b.label || `${b.provider} key`;
  return {
    ...base(accountId, "byok-credential", b.id, display, b.created_at, undefined),
    fields: {
      name: b.name ?? "",
      credentialId: b.id,
      provider: b.provider,
      label: b.label ?? "",
      workspaceId: b.workspace_id ?? "",
      disabled: b.disabled === true,
      isFallback: b.is_fallback === true,
      isByokOnly: b.is_byok_only === true,
      isRequired: b.is_required === true,
      declaredZdr: b.declared_zdr === true,
      allowedModels: join(b.allowed_models),
      restrictedToKeys: (b.allowed_api_key_hashes ?? []).length,
      sortOrder: b.sort_order ?? 0,
      createdAt: b.created_at ?? "",
    },
    resolvedOutputs: { credentialId: b.id, provider: b.provider },
  };
}

// ---------------------------------------------------------------- request bodies

function bool(value: string | undefined): boolean {
  return value === "true";
}

function money(value: string | undefined): number | null {
  if (value === undefined || value.trim() === "") return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error("OpenRouter plugin: limits must be a non-negative dollar amount");
  }
  return parsed === 0 ? null : parsed;
}

/**
 * POST /guardrails and PATCH /guardrails/{id}. Only keys present in `fields`
 * are sent, so a PATCH carries just what the user changed.
 */
export function guardrailBody(fields: Record<string, string>): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (fields["name"] !== undefined) body["name"] = fields["name"];
  if (fields["description"] !== undefined) body["description"] = fields["description"] || null;
  if (fields["limitUsd"] !== undefined) body["limit_usd"] = money(fields["limitUsd"]);
  if (fields["resetInterval"] !== undefined) {
    body["reset_interval"] =
      fields["resetInterval"] === "never" || fields["resetInterval"] === ""
        ? null
        : fields["resetInterval"];
  }
  if (fields["includeByokInBudgets"] !== undefined) {
    body["include_byok_in_budgets"] = bool(fields["includeByokInBudgets"]);
  }
  const lists: Array<[string, string]> = [
    ["allowedProviders", "allowed_providers"],
    ["ignoredProviders", "ignored_providers"],
    ["allowedModels", "allowed_models"],
    ["ignoredModels", "ignored_models"],
    ["allowedDataRegions", "allowed_data_regions"],
  ];
  for (const [key, wire] of lists) {
    if (fields[key] !== undefined) body[wire] = parseList(fields[key]);
  }
  const flags: Array<[string, string]> = [
    ["enforceZdr", "enforce_zdr"],
    ["enablePaidModelTraining", "enable_paid_model_training"],
    ["enableFreeModelTraining", "enable_free_model_training"],
    ["enableFreeModelPublication", "enable_free_model_publication"],
  ];
  for (const [key, wire] of flags) {
    if (fields[key] !== undefined) body[wire] = bool(fields[key]);
  }
  return body;
}

/** POST /workspaces and PATCH /workspaces/{id}: workspace settings, not budgets. */
export function workspaceBody(fields: Record<string, string>): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (fields["name"] !== undefined) body["name"] = fields["name"];
  if (fields["slug"] !== undefined) body["slug"] = fields["slug"];
  if (fields["description"] !== undefined) body["description"] = fields["description"] || null;
  if (fields["defaultTextModel"] !== undefined) {
    body["default_text_model"] = fields["defaultTextModel"] || null;
  }
  if (fields["defaultImageModel"] !== undefined) {
    body["default_image_model"] = fields["defaultImageModel"] || null;
  }
  if (fields["defaultProviderSort"] !== undefined) {
    body["default_provider_sort"] =
      fields["defaultProviderSort"] === "default" || fields["defaultProviderSort"] === ""
        ? null
        : fields["defaultProviderSort"];
  }
  if (fields["ioLoggingEnabled"] !== undefined) {
    body["is_observability_io_logging_enabled"] = bool(fields["ioLoggingEnabled"]);
  }
  if (fields["ioLoggingSamplingRate"] !== undefined && fields["ioLoggingSamplingRate"] !== "") {
    const rate = Number(fields["ioLoggingSamplingRate"]);
    if (!Number.isFinite(rate) || rate < 0 || rate > 1) {
      throw new Error("OpenRouter plugin: the I/O logging sampling rate must be between 0 and 1");
    }
    body["io_logging_sampling_rate"] = rate;
  }
  if (fields["broadcastEnabled"] !== undefined) {
    body["is_observability_broadcast_enabled"] = bool(fields["broadcastEnabled"]);
  }
  if (fields["dataDiscountLoggingEnabled"] !== undefined) {
    body["is_data_discount_logging_enabled"] = bool(fields["dataDiscountLoggingEnabled"]);
  }
  return body;
}

/** Budget edits implied by a workspace form: a cleared or zero amount removes the budget. */
export function workspaceBudgetChanges(
  fields: Record<string, string>,
): Array<{ interval: BudgetInterval; limitUsd: number | null }> {
  const keys: Record<BudgetInterval, string> = {
    daily: "budgetDaily",
    weekly: "budgetWeekly",
    monthly: "budgetMonthly",
    lifetime: "budgetLifetime",
  };
  const out: Array<{ interval: BudgetInterval; limitUsd: number | null }> = [];
  for (const interval of BUDGET_INTERVALS) {
    const raw = fields[keys[interval]];
    if (raw === undefined) continue;
    out.push({ interval, limitUsd: money(raw) });
  }
  return out;
}

/** POST /byok and PATCH /byok/{id}. `provider` and `workspace_id` are create-only. */
export function byokBody(fields: Record<string, string>, create: boolean): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (create) {
    body["provider"] = fields["provider"];
    if (fields["workspaceId"]) body["workspace_id"] = fields["workspaceId"];
  }
  if (fields["key"]) body["key"] = fields["key"];
  if (fields["name"] !== undefined) body["name"] = fields["name"] || null;
  const flags: Array<[string, string]> = [
    ["disabled", "disabled"],
    ["isFallback", "is_fallback"],
    ["isByokOnly", "is_byok_only"],
    ["isRequired", "is_required"],
  ];
  for (const [key, wire] of flags) {
    if (fields[key] !== undefined) body[wire] = bool(fields[key]);
  }
  if (fields["allowedModels"] !== undefined) {
    body["allowed_models"] = parseList(fields["allowedModels"]);
  }
  return body;
}

// ------------------------------------------------------------------ create forms

export interface PickerSources {
  providers: Array<{ slug: string; name?: string }>;
  models: Array<{ id: string; name?: string }>;
  keys: Array<{ hash: string; name?: string; label?: string }>;
  workspaces: Array<{ id: string; name?: string; slug?: string }>;
}

function workspaceOptions(sources: PickerSources): SelectOption[] {
  return sources.workspaces.map((w) => ({ id: w.id, label: w.name || w.slug || w.id }));
}

export function guardrailCreateConfig(sources: PickerSources): CreateResourceConfig {
  const providers: PolicyOption[] = sources.providers.map((p) => ({
    id: p.slug,
    label: p.name || p.slug,
  }));
  const models: PolicyOption[] = sources.models.map((m) => ({
    id: m.id,
    label: m.name || m.id,
    category: m.id.split("/")[0] ?? "",
  }));
  const keys: PolicyOption[] = sources.keys.map((k) => ({
    id: k.hash,
    label: k.name || k.label || k.hash.slice(0, 12),
    ...(k.label ? { description: k.label } : {}),
  }));
  const workspaces = workspaceOptions(sources);

  return {
    fields: [
      { key: "name", label: "Name", kind: "text", required: true },
      { key: "description", label: "Description", kind: "text", required: false },
      ...(workspaces.length > 0
        ? [
            {
              key: "workspaceId",
              label: "Workspace",
              kind: "select" as const,
              required: false,
              options: [{ id: "", label: "Default workspace" }, ...workspaces],
              defaultValue: "",
            },
          ]
        : []),
      {
        key: "limitUsd",
        label: "Spend limit (USD)",
        kind: "number",
        required: false,
        minValue: 0,
        description: "Per key or member the guardrail covers. Leave blank for no limit.",
      },
      {
        key: "resetInterval",
        label: "Limit resets",
        kind: "select",
        required: false,
        options: RESET_OPTIONS,
        defaultValue: "never",
      },
      {
        key: "includeByokInBudgets",
        label: "Count BYOK usage toward the limit",
        kind: "select",
        required: false,
        options: YES_NO,
        defaultValue: "false",
      },
      {
        key: "allowedProviders",
        label: "Allowed providers",
        kind: "policy-picker",
        required: false,
        policies: providers,
        description: "Only these providers may serve requests. Leave empty to allow all.",
      },
      {
        key: "ignoredProviders",
        label: "Blocked providers",
        kind: "policy-picker",
        required: false,
        policies: providers,
      },
      {
        key: "allowedModels",
        label: "Allowed models",
        kind: "policy-picker",
        required: false,
        policies: models,
        description: "Only these models may be called. Leave empty to allow all.",
      },
      {
        key: "ignoredModels",
        label: "Blocked models",
        kind: "policy-picker",
        required: false,
        policies: models,
      },
      {
        key: "allowedDataRegions",
        label: "Allowed data regions",
        kind: "policy-picker",
        required: false,
        policies: DATA_REGIONS,
        description: "Restrict routing to providers processing data in these regions.",
      },
      {
        key: "enforceZdr",
        label: "Require zero data retention",
        kind: "select",
        required: false,
        options: YES_NO,
        defaultValue: "false",
      },
      {
        key: "enablePaidModelTraining",
        label: "Allow paid providers to train on prompts",
        kind: "select",
        required: false,
        options: YES_NO,
        defaultValue: "false",
      },
      {
        key: "enableFreeModelTraining",
        label: "Allow free providers to train on prompts",
        kind: "select",
        required: false,
        options: YES_NO,
        defaultValue: "false",
      },
      {
        key: "assignedKeys",
        label: "Apply to API keys",
        kind: "policy-picker",
        required: false,
        policies: keys,
        description: "Keys this guardrail is assigned to on creation.",
      },
    ],
  };
}

export function workspaceCreateConfig(sources: PickerSources): CreateResourceConfig {
  const models: SelectOption[] = [
    { id: "", label: "None" },
    ...sources.models.map((m) => ({ id: m.id, label: m.name || m.id })),
  ];
  return {
    fields: [
      { key: "name", label: "Name", kind: "text", required: true, placeholder: "Production" },
      {
        key: "slug",
        label: "Slug",
        kind: "text",
        required: true,
        placeholder: "production",
        description: "Lowercase identifier used in URLs and the workspace_ref path segment.",
      },
      { key: "description", label: "Description", kind: "text", required: false },
      {
        key: "defaultTextModel",
        label: "Default text model",
        kind: "select",
        required: false,
        options: models,
        defaultValue: "",
      },
      {
        key: "defaultProviderSort",
        label: "Default provider sort",
        kind: "select",
        required: false,
        options: PROVIDER_SORT_OPTIONS,
        defaultValue: "default",
      },
      {
        key: "budgetMonthly",
        label: "Monthly budget (USD)",
        kind: "number",
        required: false,
        minValue: 0,
        description:
          "Leave blank for no budget. Daily, weekly and lifetime budgets can be set after creation.",
      },
    ],
  };
}

export function byokCreateConfig(sources: PickerSources): CreateResourceConfig {
  const workspaces = workspaceOptions(sources);
  return {
    fields: [
      {
        key: "provider",
        label: "Provider",
        kind: "select",
        required: true,
        options: sources.providers.map((p) => ({ id: p.slug, label: p.name || p.slug })),
      },
      {
        key: "key",
        label: "Provider API key",
        kind: "password",
        required: true,
        description:
          "Your key for that provider. OpenRouter stores it encrypted and never returns it.",
      },
      { key: "name", label: "Name", kind: "text", required: false },
      ...(workspaces.length > 0
        ? [
            {
              key: "workspaceId",
              label: "Workspace",
              kind: "select" as const,
              required: false,
              options: [{ id: "", label: "Default workspace" }, ...workspaces],
              defaultValue: "",
            },
          ]
        : []),
      {
        key: "isFallback",
        label: "Fall back to OpenRouter credits when this key fails",
        kind: "select",
        required: false,
        options: YES_NO,
        defaultValue: "false",
      },
      {
        key: "isByokOnly",
        label: "Only ever use this key for the provider",
        kind: "select",
        required: false,
        options: YES_NO,
        defaultValue: "false",
      },
    ],
  };
}

// --------------------------------------------------------------- detail views

function text(value: unknown, fallback = DASH): string {
  const s = value === undefined || value === null ? "" : String(value);
  return s || fallback;
}

function yes(value: unknown): string {
  return value === true ? "Yes" : "No";
}

function usd(value: unknown): string {
  const n = Number(value ?? 0);
  return n > 0 ? `$${n.toFixed(2)}` : "none";
}

const refresh = [
  { kind: "action" as const, label: "Refresh", action: { type: "refresh-resource" as const } },
];

export function renderGuardrailDetail(resource: ResourceInstance): DetailViewSchema {
  const f = resource.fields;
  const assignments = parseJson<OrGuardrailKeyAssignment[]>(
    resource.resolvedOutputs["__keyAssignments__"],
    [],
  );
  const builtins = parseJson<Array<{ slug?: string; action?: string }>>(
    resource.resolvedOutputs["__builtinFilters__"],
    [],
  );
  const policy: KVItem[] = [
    { key: "Allowed providers", value: text(f["allowedProviders"], "all") },
    { key: "Blocked providers", value: text(f["ignoredProviders"], "none") },
    { key: "Allowed models", value: text(f["allowedModels"], "all") },
    { key: "Blocked models", value: text(f["ignoredModels"], "none") },
    { key: "Allowed data regions", value: text(f["allowedDataRegions"], "any") },
    { key: "Zero data retention", value: f["enforceZdr"] === true ? "Required" : "Not required" },
    {
      key: "Paid-model training",
      value: f["enablePaidModelTraining"] === true ? "Allowed" : "Blocked",
    },
    {
      key: "Free-model training",
      value: f["enableFreeModelTraining"] === true ? "Allowed" : "Blocked",
    },
    { key: "Content filters", value: text(f["contentFilters"], "0") },
  ];
  const sections: SectionNode[] = [
    {
      kind: "section",
      title: "Guardrail",
      children: [
        {
          kind: "key-value-list",
          items: [
            { key: "ID", value: text(f["guardrailId"]), copyable: true },
            { key: "Description", value: text(f["description"]) },
            { key: "Workspace", value: text(f["workspaceId"], "default") },
            { key: "Created", value: text(f["createdAt"]) },
            { key: "Updated", value: text(f["updatedAt"]) },
          ],
        },
      ],
    },
    {
      kind: "section",
      title: "Budget",
      children: [
        {
          kind: "key-value-list",
          items: [
            { key: "Limit", value: usd(f["limitUsd"]) },
            { key: "Resets", value: text(f["resetInterval"], "never") },
            { key: "BYOK counts toward limit", value: yes(f["includeByokInBudgets"]) },
          ],
        },
      ],
    },
    {
      kind: "section",
      title: "Routing policy",
      children: [{ kind: "key-value-list", items: policy }],
    },
  ];
  if (builtins.length > 0) {
    sections.push({
      kind: "section",
      title: "Built-in content filters",
      children: [
        {
          kind: "table",
          columns: [
            { key: "slug", label: "Filter" },
            { key: "action", label: "Action" },
          ],
          rows: builtins.map((b) => ({ cells: { slug: text(b.slug), action: text(b.action) } })),
        },
      ],
    });
  }
  sections.push({
    kind: "section",
    title: "Assigned API keys",
    children:
      assignments.length > 0
        ? [
            {
              kind: "table",
              columns: [
                { key: "name", label: "Key" },
                { key: "hash", label: "Hash", mono: true },
              ],
              rows: assignments.map((a) => ({
                cells: { name: a.key_name || a.key_label || DASH, hash: a.key_hash },
              })),
            },
          ]
        : [
            {
              kind: "text",
              variant: "muted",
              content: "No API keys are assigned to this guardrail.",
            },
          ],
  });
  return {
    title: resource.displayName,
    subtitle: "OpenRouter Guardrail",
    status: { kind: "status-dot", status: "healthy" },
    sections,
    headerActions: refresh,
  };
}

export function renderWorkspaceDetail(resource: ResourceInstance): DetailViewSchema {
  const f = resource.fields;
  const hasBudgets = f["budgetMonthly"] !== undefined;
  return {
    // Analytics API series filtered to this workspace; see `fetchMetricSeries`.
    metricsCapability: { defaultTimeRangeMs: 30 * 24 * 60 * 60 * 1000 },
    title: resource.displayName,
    subtitle: joinParts("OpenRouter Workspace", f["slug"]),
    status: { kind: "status-dot", status: "healthy" },
    sections: [
      {
        kind: "section",
        title: "Workspace",
        children: [
          {
            kind: "key-value-list",
            items: [
              { key: "ID", value: text(f["workspaceId"]), copyable: true },
              { key: "Slug", value: text(f["slug"]), copyable: true },
              { key: "Description", value: text(f["description"]) },
              { key: "Default text model", value: text(f["defaultTextModel"], "none") },
              { key: "Default image model", value: text(f["defaultImageModel"], "none") },
              { key: "Default provider sort", value: text(f["defaultProviderSort"], "default") },
              { key: "Default guardrail", value: text(f["defaultGuardrailId"], "none") },
              ...(f["memberCount"] !== undefined
                ? [{ key: "Members", value: String(f["memberCount"]) }]
                : []),
              { key: "Created", value: text(f["createdAt"]) },
            ],
          },
        ],
      },
      {
        kind: "section",
        title: "Budgets",
        children: hasBudgets
          ? [
              {
                kind: "key-value-list",
                items: [
                  { key: "Daily", value: usd(f["budgetDaily"]) },
                  { key: "Weekly", value: usd(f["budgetWeekly"]) },
                  { key: "Monthly", value: usd(f["budgetMonthly"]) },
                  { key: "Lifetime", value: usd(f["budgetLifetime"]) },
                  { key: "BYOK counts toward budgets", value: yes(f["includeByokInBudgets"]) },
                ],
              },
            ]
          : [
              {
                kind: "text",
                variant: "muted",
                content: "Open the workspace to load its budgets.",
              },
            ],
      },
      {
        kind: "section",
        title: "Observability",
        children: [
          {
            kind: "key-value-list",
            items: [
              { key: "I/O logging", value: yes(f["ioLoggingEnabled"]) },
              {
                key: "I/O logging sample rate",
                value: `${(Number(f["ioLoggingSamplingRate"] ?? 0) * 100).toFixed(0)}%`,
              },
              { key: "Broadcast to destinations", value: yes(f["broadcastEnabled"]) },
              { key: "Data-discount logging", value: yes(f["dataDiscountLoggingEnabled"]) },
            ],
          },
        ],
      },
    ],
    headerActions: refresh,
  };
}

export function renderByokDetail(resource: ResourceInstance): DetailViewSchema {
  const f = resource.fields;
  const disabled = f["disabled"] === true;
  return {
    title: resource.displayName,
    subtitle: joinParts("OpenRouter BYOK Credential", f["provider"]),
    status: {
      kind: "status-dot",
      status: disabled ? "degraded" : "healthy",
      label: disabled ? "Disabled" : "Active",
    },
    sections: [
      {
        kind: "section",
        title: "Credential",
        children: [
          {
            kind: "key-value-list",
            items: [
              { key: "ID", value: text(f["credentialId"]), copyable: true },
              { key: "Provider", value: text(f["provider"]) },
              { key: "Key", value: text(f["label"]) },
              { key: "Workspace", value: text(f["workspaceId"], "default") },
              { key: "Created", value: text(f["createdAt"]) },
            ],
          },
        ],
      },
      {
        kind: "section",
        title: "Routing",
        children: [
          {
            kind: "key-value-list",
            items: [
              { key: "Falls back to OpenRouter credits", value: yes(f["isFallback"]) },
              { key: "BYOK only", value: yes(f["isByokOnly"]) },
              { key: "Required", value: yes(f["isRequired"]) },
              { key: "Declared zero data retention", value: yes(f["declaredZdr"]) },
              { key: "Allowed models", value: text(f["allowedModels"], "all") },
              {
                key: "Restricted to API keys",
                value:
                  Number(f["restrictedToKeys"] ?? 0) > 0 ? String(f["restrictedToKeys"]) : "no",
              },
              { key: "Priority", value: text(f["sortOrder"], "0") },
            ],
          },
          {
            kind: "text",
            variant: "muted",
            content:
              "The provider key itself is write-only. To rotate it, edit this credential's key in the OpenRouter dashboard or create a replacement here.",
          },
        ],
      },
    ],
    headerActions: refresh,
  };
}

function joinParts(prefix: string, value: unknown): string {
  const s = value === undefined || value === null ? "" : String(value);
  return s ? `${prefix} · ${s}` : prefix;
}

function parseJson<T>(raw: string | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}
