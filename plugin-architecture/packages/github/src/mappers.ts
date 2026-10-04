/**
 * GitHub API response shapes (the fields this plugin reads, verified against
 * GitHub's published REST API description, 2026-10) and their mapping to
 * `ResourceInstance`s.
 */

import type { ResourceInstance } from "@infrawrench/plugin-base";
import { formatBytes } from "@infrawrench/plugin-base";
import { budgetProductLabel, hostedRunnerSku } from "./products.js";

export const PLUGIN_ID = "github";

/** Seats with no Copilot activity for this long are idle. */
export const SEAT_IDLE_DAYS = 30;
/** Codespaces unused for this long are stale. */
export const CODESPACE_STALE_DAYS = 14;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface GhCopilotSeat {
  assignee?: { login?: string; name?: string | null; email?: string | null; type?: string } | null;
  organization?: { login?: string } | null;
  assigning_team?: { slug?: string; name?: string } | null;
  pending_cancellation_date?: string | null;
  last_activity_at?: string | null;
  last_activity_editor?: string | null;
  last_authenticated_at?: string | null;
  created_at?: string;
  updated_at?: string;
  plan_type?: string;
}

export interface GhHostedRunner {
  id?: number;
  name?: string;
  runner_group_id?: number;
  image_details?: {
    id?: string;
    size_gb?: number;
    display_name?: string;
    source?: string;
    version?: string;
  } | null;
  machine_size_details?: {
    id?: string;
    cpu_cores?: number;
    memory_gb?: number;
    storage_gb?: number;
  };
  status?: string;
  platform?: string;
  maximum_runners?: number;
  public_ip_enabled?: boolean;
  last_active_on?: string | null;
}

export interface GhRunner {
  id?: number;
  name?: string;
  os?: string;
  status?: string;
  busy?: boolean;
  ephemeral?: boolean;
  runner_group_id?: number;
  version?: string | null;
  labels?: Array<{ name?: string }>;
}

export interface GhRepoCacheUsage {
  full_name?: string;
  active_caches_size_in_bytes?: number;
  active_caches_count?: number;
}

export interface GhActionsCache {
  id?: number;
  ref?: string;
  key?: string;
  version?: string;
  last_accessed_at?: string;
  created_at?: string;
  size_in_bytes?: number;
}

export interface GhCodespace {
  id?: number;
  name?: string;
  display_name?: string | null;
  owner?: { login?: string };
  billable_owner?: { login?: string };
  repository?: { full_name?: string };
  machine?: {
    name?: string;
    display_name?: string;
    operating_system?: string;
    storage_in_bytes?: number;
    memory_in_bytes?: number;
    cpus?: number;
  } | null;
  devcontainer_path?: string | null;
  created_at?: string;
  last_used_at?: string;
  state?: string;
  location?: string;
  idle_timeout_minutes?: number | null;
  retention_expires_at?: string | null;
  web_url?: string;
}

export interface GhBudget {
  id?: string;
  budget_type?: string;
  budget_amount?: number;
  prevent_further_usage?: boolean;
  budget_scope?: string;
  budget_entity_name?: string;
  user?: string;
  consumed_amount?: number;
  budget_product_sku?: string;
  budget_alerting?: { will_alert?: boolean; alert_recipients?: string[] };
  expires_at?: string | null;
}

export interface GhCostCenterResource {
  type?: string;
  name?: string;
}

function instance(
  accountId: string,
  typeId: string,
  externalId: string,
  displayName: string,
  fields: Record<string, string | number | boolean | undefined | null>,
  outputs: Record<string, string | undefined> = {},
): ResourceInstance {
  const now = new Date().toISOString();
  const clean: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (v !== undefined && v !== null && v !== "") clean[k] = v;
  }
  const resolved: Record<string, string> = {};
  for (const [k, v] of Object.entries(outputs)) if (v) resolved[k] = v;
  return {
    id: `${accountId}:${typeId}:${externalId}`,
    pluginId: PLUGIN_ID,
    resourceTypeId: typeId,
    accountId,
    displayName: displayName || externalId,
    fields: clean,
    resolvedOutputs: resolved,
    secretStates: [],
    externalId,
    createdAt: now,
    updatedAt: now,
  };
}

/** Whole days between `iso` and `now`, or undefined when there is no date. */
export function daysSince(iso: string | null | undefined, now = Date.now()): number | undefined {
  if (!iso) return undefined;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return undefined;
  return Math.max(0, Math.floor((now - t) / DAY_MS));
}

export interface BillingAccountRow {
  slug: string;
  name: string;
  kind: "org" | "enterprise";
  plan?: string;
  monthToDate?: number;
  grossToDate?: number;
  discountToDate?: number;
  copilotSeats?: number;
  cacheSizeBytes?: number;
}

export function mapBillingAccount(accountId: string, row: BillingAccountRow): ResourceInstance {
  return instance(
    accountId,
    "billing-account",
    row.slug,
    row.name,
    {
      name: row.name,
      slug: row.slug,
      kind: row.kind === "org" ? "Organization" : "Enterprise",
      plan: row.plan,
      monthToDate: row.monthToDate,
      grossToDate: row.grossToDate,
      discountToDate: row.discountToDate,
      copilotSeats: row.copilotSeats,
      cacheSizeGb:
        row.cacheSizeBytes !== undefined
          ? Math.round((row.cacheSizeBytes / 1024 ** 3) * 100) / 100
          : undefined,
    },
    { slug: row.slug },
  );
}

/**
 * A seat is idle when its user has not used Copilot for {@link SEAT_IDLE_DAYS},
 * or never has and the seat is older than that (a fresh seat is not idle).
 */
export function mapCopilotSeat(
  accountId: string,
  s: GhCopilotSeat,
  monthlyPrice: number | undefined,
  now = Date.now(),
): ResourceInstance {
  const login = s.assignee?.login ?? "";
  const activityDays = daysSince(s.last_activity_at, now);
  const ageDays = daysSince(s.created_at, now) ?? 0;
  const idle =
    activityDays !== undefined ? activityDays >= SEAT_IDLE_DAYS : ageDays >= SEAT_IDLE_DAYS;
  return instance(
    accountId,
    "copilot-seat",
    login,
    login,
    {
      login,
      name: s.assignee?.name ?? undefined,
      planType: s.plan_type,
      lastActivityAt: s.last_activity_at,
      lastActivityEditor: s.last_activity_editor,
      lastAuthenticatedAt: s.last_authenticated_at,
      idleDays: activityDays,
      idle,
      assigningTeam: s.assigning_team?.slug ?? s.assigning_team?.name,
      organization: s.organization?.login,
      pendingCancellationDate: s.pending_cancellation_date,
      monthlyPrice,
      createdAt: s.created_at,
    },
    { login },
  );
}

export function mapHostedRunner(
  accountId: string,
  r: GhHostedRunner,
  skuSpend: Map<string, { net: number; pricePerUnit?: number }>,
): ResourceInstance {
  const id = String(r.id ?? "");
  const size = r.machine_size_details;
  const sku = hostedRunnerSku(r.platform, size?.cpu_cores);
  const spend = sku ? skuSpend.get(sku) : undefined;
  return instance(
    accountId,
    "hosted-runner",
    id,
    r.name ?? id,
    {
      name: r.name,
      maximumRunners: r.maximum_runners,
      enableStaticIp: r.public_ip_enabled,
      platform: r.platform,
      size: size?.id,
      cpuCores: size?.cpu_cores,
      memoryGb: size?.memory_gb,
      storageGb: size?.storage_gb,
      image: r.image_details?.display_name ?? r.image_details?.id,
      imageId: r.image_details?.id,
      imageSource: r.image_details?.source,
      status: r.status,
      runnerGroupId: r.runner_group_id !== undefined ? String(r.runner_group_id) : undefined,
      lastActiveOn: r.last_active_on,
      sku,
      pricePerMinute: spend?.pricePerUnit,
      skuMonthToDate: spend ? Math.round(spend.net * 100) / 100 : undefined,
    },
    { runnerId: id },
  );
}

export function mapRunner(accountId: string, r: GhRunner): ResourceInstance {
  const id = String(r.id ?? "");
  return instance(
    accountId,
    "runner",
    id,
    r.name ?? id,
    {
      name: r.name,
      os: r.os,
      status: r.status,
      busy: r.busy,
      labels: (r.labels ?? [])
        .map((l) => l.name)
        .filter(Boolean)
        .join(", "),
      ephemeral: r.ephemeral,
      runnerGroupId: r.runner_group_id !== undefined ? String(r.runner_group_id) : undefined,
      version: r.version,
    },
    { runnerId: id },
  );
}

export function mapActionsCache(accountId: string, u: GhRepoCacheUsage): ResourceInstance {
  const repo = u.full_name ?? "";
  const bytes = u.active_caches_size_in_bytes ?? 0;
  return instance(
    accountId,
    "actions-cache",
    repo,
    repo,
    {
      repository: repo,
      cacheCount: u.active_caches_count ?? 0,
      sizeBytes: bytes,
      size: formatBytes(bytes),
    },
    { repository: repo },
  );
}

/** Codespaces are addressed `<owner login>/<codespace name>`: the admin routes need both. */
export function codespaceExternalId(owner: string, name: string): string {
  return `${owner}/${name}`;
}

export function mapCodespace(
  accountId: string,
  c: GhCodespace,
  now = Date.now(),
): ResourceInstance {
  const owner = c.owner?.login ?? "";
  const name = c.name ?? "";
  const lastUsed = daysSince(c.last_used_at ?? c.created_at, now);
  return instance(
    accountId,
    "codespace",
    codespaceExternalId(owner, name),
    c.display_name || name,
    {
      displayName: c.display_name || name,
      owner,
      billableOwner: c.billable_owner?.login,
      repository: c.repository?.full_name,
      state: c.state,
      machine: c.machine?.display_name ?? c.machine?.name,
      cpus: c.machine?.cpus,
      memory:
        c.machine?.memory_in_bytes !== undefined
          ? formatBytes(c.machine.memory_in_bytes)
          : undefined,
      storage:
        c.machine?.storage_in_bytes !== undefined
          ? formatBytes(c.machine.storage_in_bytes)
          : undefined,
      lastUsedAt: c.last_used_at,
      idleDays: lastUsed,
      stale: lastUsed !== undefined ? lastUsed >= CODESPACE_STALE_DAYS : false,
      idleTimeoutMinutes: c.idle_timeout_minutes,
      retentionExpiresAt: c.retention_expires_at,
      location: c.location,
      devcontainerPath: c.devcontainer_path,
      createdAt: c.created_at,
      codespaceName: name,
    },
    { webUrl: c.web_url },
  );
}

const SCOPE_LABELS: Record<string, string> = {
  enterprise: "Enterprise",
  organization: "Organization",
  repository: "Repository",
  cost_center: "Cost centre",
  multi_user_customer: "Every user",
  multi_user_cost_center: "Every user in a cost centre",
  user: "User",
};

export function budgetScopeLabel(scope: string | undefined): string {
  return SCOPE_LABELS[scope ?? ""] ?? scope ?? "";
}

export function mapBudget(
  accountId: string,
  b: GhBudget,
  spentThisMonth: number | undefined,
): ResourceInstance {
  const id = b.id ?? "";
  const product = budgetProductLabel(b.budget_type, b.budget_product_sku);
  const scope = budgetScopeLabel(b.budget_scope);
  const entity = b.budget_scope === "user" ? b.user : b.budget_entity_name;
  const spent =
    b.budget_scope === "user" && b.consumed_amount !== undefined
      ? b.consumed_amount
      : spentThisMonth;
  const amount = b.budget_amount;
  return instance(
    accountId,
    "budget",
    id,
    `${product} budget, ${entity ? `${scope} ${entity}` : scope}`,
    {
      budgetAmount: amount,
      preventFurtherUsage: b.prevent_further_usage,
      willAlert: b.budget_alerting?.will_alert,
      alertRecipients: (b.budget_alerting?.alert_recipients ?? []).join(", "),
      expiresAt: b.expires_at,
      product,
      budgetType: b.budget_type,
      productSku: b.budget_product_sku,
      scope,
      scopeId: b.budget_scope,
      entity,
      user: b.user,
      spentThisMonth: spent !== undefined ? Math.round(spent * 100) / 100 : undefined,
      percentUsed:
        spent !== undefined && amount ? Math.round((spent / amount) * 1000) / 10 : undefined,
    },
    { budgetId: id },
  );
}

/** Cost centre resources are typed `User`, `Org`, `Repo` and `Team` (enterprise teams) in the listing. */
export function costCenterMembers(resources: GhCostCenterResource[] | undefined): {
  users: string[];
  organizations: string[];
  repositories: string[];
  enterpriseTeams: string[];
} {
  const out = {
    users: [] as string[],
    organizations: [] as string[],
    repositories: [] as string[],
    enterpriseTeams: [] as string[],
  };
  for (const r of resources ?? []) {
    const type = (r.type ?? "").toLowerCase().replace(/[^a-z]/g, "");
    if (!r.name) continue;
    if (type === "user") out.users.push(r.name);
    else if (type === "org" || type === "organization") out.organizations.push(r.name);
    else if (type === "repo" || type === "repository") out.repositories.push(r.name);
    else if (type.includes("team")) out.enterpriseTeams.push(r.name);
  }
  return out;
}

export function mapCostCenter(
  accountId: string,
  c: {
    id?: string;
    name?: string;
    state?: string;
    azure_subscription?: string | null;
    ai_credit_pool_enabled?: boolean;
    resources?: GhCostCenterResource[];
  },
  monthToDate: number | undefined,
): ResourceInstance {
  const id = c.id ?? "";
  const members = costCenterMembers(c.resources);
  return instance(
    accountId,
    "cost-center",
    id,
    c.name ?? id,
    {
      name: c.name,
      users: members.users.join(", "),
      organizations: members.organizations.join(", "),
      repositories: members.repositories.join(", "),
      enterpriseTeams: members.enterpriseTeams.join(", "),
      aiCreditPoolEnabled: c.ai_credit_pool_enabled,
      state: c.state,
      azureSubscription: c.azure_subscription,
      monthToDate: monthToDate !== undefined ? Math.round(monthToDate * 100) / 100 : undefined,
    },
    { costCenterId: id },
  );
}
