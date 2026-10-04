import type {
  CostFetchRange,
  CostRow,
  CreateFieldConfig,
  CreateResourceConfig,
  DashboardStat,
  DetailViewSchema,
  HostServices,
  MetricSeries,
  PluginClient,
  PreflightResult,
  ResourceInstance,
  SidebarItemSchema,
} from "@infrawrench/plugin-base";
import { externalIdOf } from "@infrawrench/plugin-base";
import type { GitHubContext } from "./api.js";
import {
  billingBase,
  ghFetch,
  ghPaged,
  ownerBase,
  ownerSegment,
  parseOwner,
  resolveHost,
  statusOf,
} from "./api.js";
import { fetchGitHubCostData } from "./cost-data.js";
import type {
  GhActionsCache,
  GhBudget,
  GhCodespace,
  GhCopilotSeat,
  GhHostedRunner,
  GhRepoCacheUsage,
  GhRunner,
} from "./mappers.js";
import {
  costCenterMembers,
  mapActionsCache,
  mapBillingAccount,
  mapBudget,
  mapCodespace,
  mapCopilotSeat,
  mapCostCenter,
  mapHostedRunner,
  mapRunner,
} from "./mappers.js";
import { METRICS_WINDOW_MS, billingAccountSeries, rangeOrDefault } from "./metrics.js";
import { verifyGitHubCredentials } from "./preflight.js";
import {
  PRODUCTS,
  budgetProductOptions,
  normalizeId,
  parseBudgetProduct,
  productLabel,
} from "./products.js";
import {
  AI_CREDIT_KEY,
  CACHES_KEY,
  PREMIUM_KEY,
  SEAT_BREAKDOWN_KEY,
  SUMMARY_KEY,
  renderGitHubDetail,
  renderGitHubSidebar,
} from "./render.js";
import type { CostCenter, SummaryItem, TaggedUsageItem } from "./usage.js";
import {
  currentYearMonth,
  fetchCostCenters,
  fetchModelUsage,
  fetchMonthItems,
  fetchUsageSummary,
  sumItems,
} from "./usage.js";

/** How long one listing pass reuses this month's usage and summary. */
const MEMO_TTL_MS = 60_000;

const ORG_ONLY = new Set(["runner", "actions-cache", "codespace"]);
const ENTERPRISE_ONLY = new Set(["cost-center"]);

const SEAT_SKU: Record<string, string> = {
  business: "copilot_for_business",
  enterprise: "copilot_enterprise",
};

const list = (raw: string | undefined): string[] =>
  (raw ?? "")
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean);

const yes = (raw: string | undefined): boolean => /^(true|yes|1|on)$/i.test((raw ?? "").trim());

export class GitHubClient implements PluginClient {
  readonly ctx: GitHubContext;
  private memo = new Map<string, { at: number; value: Promise<unknown> }>();

  constructor(credentials: Record<string, string>, services?: HostServices) {
    const token = (credentials["token"] ?? "").trim();
    if (!token) throw new Error("GitHub plugin: missing token credential");
    const owner = parseOwner(credentials["owner"]);
    if (!owner) throw new Error("GitHub plugin: missing organization or enterprise");
    const caCert = credentials["caCert"] ?? "";
    this.ctx = {
      token,
      host: resolveHost(credentials["host"]),
      owner,
      ...(caCert ? { caCert } : {}),
      ...(services?.http ? { http: services.http } : {}),
    };
  }

  private get isOrg(): boolean {
    return this.ctx.owner.kind === "org";
  }

  private cached<T>(key: string, load: () => Promise<T>): Promise<T> {
    const hit = this.memo.get(key);
    if (hit && Date.now() - hit.at < MEMO_TTL_MS) return hit.value as Promise<T>;
    const value = load();
    this.memo.set(key, { at: Date.now(), value });
    value.catch(() => this.memo.delete(key));
    return value;
  }

  private monthSummary(): Promise<SummaryItem[]> {
    return this.cached("summary", () => fetchUsageSummary(this.ctx, currentYearMonth()));
  }

  private costCenters(): Promise<CostCenter[]> {
    return this.cached("costCenters", () => fetchCostCenters(this.ctx));
  }

  private monthItems(): Promise<TaggedUsageItem[]> {
    return this.cached("items", async () =>
      fetchMonthItems(this.ctx, currentYearMonth(), await this.costCenters().catch(() => [])),
    );
  }

  private invalidate(): void {
    this.memo.clear();
  }

  // -------------------------------------------------------------------------
  // Listing
  // -------------------------------------------------------------------------

  /**
   * A 403 or 404 on one list means the token lacks that one permission (GitHub
   * answers 404 for things a token may not see) or the product is not enabled
   * (no Copilot subscription, no larger runners); the rest of the account
   * still works, so that type lists empty. A 401 (bad token) still throws.
   */
  private async scoped(load: () => Promise<ResourceInstance[]>): Promise<ResourceInstance[]> {
    try {
      return await load();
    } catch (err) {
      const status = statusOf(err);
      if (status === 403 || status === 404 || status === 422) return [];
      throw err;
    }
  }

  async listResources(typeId: string, accountId: string): Promise<ResourceInstance[]> {
    if (ORG_ONLY.has(typeId) && !this.isOrg) return [];
    if (ENTERPRISE_ONLY.has(typeId) && this.isOrg) return [];
    switch (typeId) {
      case "billing-account":
        return [await this.billingAccount(accountId)];
      case "copilot-seat":
        return this.scoped(() => this.listSeats(accountId));
      case "hosted-runner":
        return this.scoped(() => this.listHostedRunners(accountId));
      case "runner":
        return this.scoped(async () =>
          (
            await ghPaged<GhRunner, { runners?: GhRunner[] }>(
              this.ctx,
              `${ownerBase(this.ctx.owner)}/actions/runners`,
              (r) => r.runners,
            )
          ).map((r) => mapRunner(accountId, r)),
        );
      case "actions-cache":
        return this.scoped(async () =>
          (
            await ghPaged<GhRepoCacheUsage, { repository_cache_usages?: GhRepoCacheUsage[] }>(
              this.ctx,
              `${ownerBase(this.ctx.owner)}/actions/cache/usage-by-repository`,
              (r) => r.repository_cache_usages,
            )
          )
            .filter((u) => u.full_name)
            .map((u) => mapActionsCache(accountId, u)),
        );
      case "codespace":
        return this.scoped(async () =>
          (
            await ghPaged<GhCodespace, { codespaces?: GhCodespace[] }>(
              this.ctx,
              `${ownerBase(this.ctx.owner)}/codespaces`,
              (r) => r.codespaces,
            )
          ).map((c) => mapCodespace(accountId, c)),
        );
      case "budget":
        return this.scoped(() => this.listBudgets(accountId));
      case "cost-center":
        return this.scoped(() => this.listCostCenters(accountId));
      default:
        throw new Error(`GitHub plugin: unknown resource type "${typeId}"`);
    }
  }

  /**
   * The account root. Spend fields come from this month's summary and are
   * simply absent when the token cannot read billing; the root itself always
   * exists so the account is never empty.
   */
  private async billingAccount(accountId: string): Promise<ResourceInstance> {
    const owner = this.ctx.owner;
    const [summary, org, seats, cache] = await Promise.all([
      this.monthSummary().catch(() => undefined),
      this.isOrg
        ? ghFetch<{ name?: string | null; login?: string; plan?: { name?: string } }>(
            this.ctx,
            `/orgs/${ownerSegment(owner)}`,
          ).catch(() => undefined)
        : Promise.resolve(undefined),
      ghFetch<{ total_seats?: number }>(this.ctx, `${ownerBase(owner)}/copilot/billing/seats`, {
        query: { per_page: 1 },
      }).catch(() => undefined),
      ghFetch<{ total_active_caches_size_in_bytes?: number }>(
        this.ctx,
        `${ownerBase(owner)}/actions/cache/usage`,
      ).catch(() => undefined),
    ]);
    const totals = summary ? sumItems(summary) : undefined;
    return mapBillingAccount(accountId, {
      slug: owner.slug,
      name: org?.name || owner.slug,
      kind: owner.kind,
      ...(org?.plan?.name ? { plan: org.plan.name } : {}),
      ...(totals
        ? { monthToDate: totals.net, grossToDate: totals.gross, discountToDate: totals.discount }
        : {}),
      ...(seats?.total_seats !== undefined ? { copilotSeats: seats.total_seats } : {}),
      ...(cache?.total_active_caches_size_in_bytes !== undefined
        ? { cacheSizeBytes: cache.total_active_caches_size_in_bytes }
        : {}),
    });
  }

  private async listSeats(accountId: string): Promise<ResourceInstance[]> {
    const [seats, summary] = await Promise.all([
      ghPaged<GhCopilotSeat, { seats?: GhCopilotSeat[] }>(
        this.ctx,
        `${ownerBase(this.ctx.owner)}/copilot/billing/seats`,
        (r) => r.seats,
      ),
      this.monthSummary().catch(() => [] as SummaryItem[]),
    ]);
    const price = (plan: string | undefined): number | undefined => {
      const sku = SEAT_SKU[(plan ?? "").toLowerCase()];
      if (!sku) return undefined;
      const item = summary.find((i) => normalizeId(i.sku) === sku && i.pricePerUnit);
      return item?.pricePerUnit;
    };
    return seats
      .filter((s) => s.assignee?.login)
      .map((s) => mapCopilotSeat(accountId, s, price(s.plan_type)));
  }

  private async skuSpend(): Promise<Map<string, { net: number; pricePerUnit?: number }>> {
    const summary = await this.monthSummary().catch(() => [] as SummaryItem[]);
    const out = new Map<string, { net: number; pricePerUnit?: number }>();
    for (const i of summary) {
      const sku = normalizeId(i.sku);
      if (!sku) continue;
      const cur = out.get(sku) ?? { net: 0 };
      cur.net += i.netAmount ?? 0;
      if (i.pricePerUnit) cur.pricePerUnit = i.pricePerUnit;
      out.set(sku, cur);
    }
    return out;
  }

  private async listHostedRunners(accountId: string): Promise<ResourceInstance[]> {
    const [runners, spend] = await Promise.all([
      ghPaged<GhHostedRunner, { runners?: GhHostedRunner[] }>(
        this.ctx,
        `${ownerBase(this.ctx.owner)}/actions/hosted-runners`,
        (r) => r.runners,
      ),
      this.skuSpend(),
    ]);
    return runners.map((r) => mapHostedRunner(accountId, r, spend));
  }

  private async fetchBudgets(): Promise<GhBudget[]> {
    const out: GhBudget[] = [];
    for (let page = 1; page <= 20; page++) {
      const res = await ghFetch<{ budgets?: GhBudget[]; has_next_page?: boolean }>(
        this.ctx,
        `${billingBase(this.ctx.owner)}/budgets`,
        { query: { per_page: 100, page } },
      );
      out.push(...(res.budgets ?? []));
      if (!res.has_next_page || (res.budgets ?? []).length === 0) break;
    }
    return out;
  }

  /** This month's net spend that falls under a budget, from the usage line items. */
  static budgetSpend(
    b: GhBudget,
    items: TaggedUsageItem[],
    centers: CostCenter[],
  ): number | undefined {
    const scope = b.budget_scope ?? "";
    if (scope === "user" || scope.startsWith("multi_user")) return undefined;
    const target = normalizeId(b.budget_product_sku);
    const matchesProduct = (i: TaggedUsageItem): boolean => {
      const sku = normalizeId(i.sku);
      if (b.budget_type === "BundlePricing") {
        return sku.includes("ai_credit") || normalizeId(i.unitType).includes("credit");
      }
      if (b.budget_type === "ProductPricing") {
        const label = PRODUCTS.find((p) => p.id === target)?.label;
        return (
          normalizeId(i.product) === target || (!!label && productLabel(i.product, i.sku) === label)
        );
      }
      if (target === "premium_requests") return sku.includes("premium_request");
      return sku === target;
    };
    const entity = (b.budget_entity_name ?? "").toLowerCase();
    const matchesScope = (i: TaggedUsageItem): boolean => {
      if (scope === "repository") {
        const repo = (i.repositoryName ?? "").toLowerCase();
        return !!repo && (repo === entity || repo.endsWith(`/${entity}`));
      }
      if (scope === "organization" && entity) {
        return (i.organizationName ?? "").toLowerCase() === entity;
      }
      if (scope === "cost_center") {
        const center = centers.find(
          (c) => (c.name ?? "").toLowerCase() === entity || (c.id ?? "").toLowerCase() === entity,
        );
        return !!center && i.costCenterId === center.id;
      }
      return true;
    };
    let total = 0;
    for (const i of items) if (matchesProduct(i) && matchesScope(i)) total += i.netAmount ?? 0;
    return total;
  }

  private async listBudgets(accountId: string): Promise<ResourceInstance[]> {
    const [budgets, items, centers] = await Promise.all([
      this.fetchBudgets(),
      this.monthItems().catch(() => undefined),
      this.costCenters().catch(() => [] as CostCenter[]),
    ]);
    return budgets
      .filter((b) => b.id)
      .map((b) =>
        mapBudget(accountId, b, items ? GitHubClient.budgetSpend(b, items, centers) : undefined),
      );
  }

  private async listCostCenters(accountId: string): Promise<ResourceInstance[]> {
    const [centers, items] = await Promise.all([
      this.costCenters(),
      this.monthItems().catch(() => undefined),
    ]);
    return centers.map((c) => {
      const spend = items
        ? items.filter((i) => i.costCenterId === c.id).reduce((s, i) => s + (i.netAmount ?? 0), 0)
        : undefined;
      return mapCostCenter(accountId, c, spend);
    });
  }

  // -------------------------------------------------------------------------
  // Single reads
  // -------------------------------------------------------------------------

  async getResource(
    typeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<ResourceInstance> {
    const id = externalIdOf(resourceId);
    if (typeId === "billing-account") {
      const base = await this.billingAccount(accountId);
      const ym = currentYearMonth();
      const [summary, premium, credits, seats] = await Promise.all([
        this.monthSummary().catch(() => undefined),
        fetchModelUsage(this.ctx, "premium_request", ym).catch(() => undefined),
        fetchModelUsage(this.ctx, "ai_credit", ym).catch(() => undefined),
        this.isOrg
          ? ghFetch<{ seat_breakdown?: unknown }>(
              this.ctx,
              `${ownerBase(this.ctx.owner)}/copilot/billing`,
            ).catch(() => undefined)
          : Promise.resolve(undefined),
      ]);
      return {
        ...base,
        resolvedOutputs: {
          ...base.resolvedOutputs,
          ...(summary ? { [SUMMARY_KEY]: JSON.stringify(summary) } : {}),
          ...(premium?.length ? { [PREMIUM_KEY]: JSON.stringify(premium) } : {}),
          ...(credits?.length ? { [AI_CREDIT_KEY]: JSON.stringify(credits) } : {}),
          ...(seats?.seat_breakdown
            ? { [SEAT_BREAKDOWN_KEY]: JSON.stringify(seats.seat_breakdown) }
            : {}),
        },
      };
    }
    if (typeId === "actions-cache") {
      const repoPath = `/repos/${id.split("/").map(encodeURIComponent).join("/")}`;
      const [usage, caches] = await Promise.all([
        ghFetch<GhRepoCacheUsage>(this.ctx, `${repoPath}/actions/cache/usage`),
        ghFetch<{ actions_caches?: GhActionsCache[] }>(this.ctx, `${repoPath}/actions/caches`, {
          query: { per_page: 50, sort: "size_in_bytes", direction: "desc" },
        }).catch(() => undefined),
      ]);
      const r = mapActionsCache(accountId, { ...usage, full_name: usage.full_name ?? id });
      return caches?.actions_caches
        ? {
            ...r,
            resolvedOutputs: {
              ...r.resolvedOutputs,
              [CACHES_KEY]: JSON.stringify(caches.actions_caches),
            },
          }
        : r;
    }
    const all = await this.listResources(typeId, accountId);
    const found = all.find((r) => r.id === resourceId || r.externalId === id);
    if (!found) throw new Error(`GitHub plugin: resource ${typeId}/${resourceId} not found`);
    return found;
  }

  async resolveOutput(
    typeId: string,
    resourceId: string,
    outputKey: string,
    accountId: string,
  ): Promise<string> {
    const resource = await this.getResource(typeId, resourceId, accountId);
    const resolved = resource.resolvedOutputs[outputKey];
    if (resolved !== undefined) return resolved;
    const field = resource.fields[outputKey];
    if (field !== undefined) return String(field);
    throw new Error(`GitHub plugin: cannot resolve output "${outputKey}" for type "${typeId}"`);
  }

  // -------------------------------------------------------------------------
  // Stats, metrics and costs
  // -------------------------------------------------------------------------

  async fetchDashboardStats(
    resourceTypeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<DashboardStat[]> {
    const r = await this.getResource(resourceTypeId, resourceId, accountId);
    const f = r.fields;
    const usd = (v: unknown) =>
      typeof v === "number" ? `$${v.toLocaleString("en-US", { maximumFractionDigits: 0 })}` : "—";
    switch (resourceTypeId) {
      case "billing-account":
        return [
          { label: "Net This Month", value: usd(f["monthToDate"]) },
          { label: "Discounts", value: usd(f["discountToDate"]) },
          { label: "Copilot Seats", value: String(f["copilotSeats"] ?? "—") },
        ];
      case "copilot-seat":
        return [
          {
            label: "Status",
            value: f["idle"] === true ? "Idle" : "Active",
            variant: f["idle"] === true ? "status-degraded" : "status-healthy",
          },
          { label: "Days Since Activity", value: String(f["idleDays"] ?? "—") },
        ];
      case "budget":
        return [
          { label: "Spent", value: usd(f["spentThisMonth"]) },
          { label: "Budget", value: usd(f["budgetAmount"]) },
        ];
      case "actions-cache":
        return [
          { label: "Size", value: String(f["size"] ?? "—") },
          { label: "Caches", value: String(f["cacheCount"] ?? "—") },
        ];
      case "codespace":
        return [
          { label: "State", value: String(f["state"] ?? "—") },
          { label: "Days Since Use", value: String(f["idleDays"] ?? "—") },
        ];
      case "hosted-runner":
        return [
          { label: "Status", value: String(f["status"] ?? "—") },
          { label: "SKU This Month", value: usd(f["skuMonthToDate"]) },
        ];
      default:
        return [];
    }
  }

  async fetchMetricSeries(
    resourceTypeId: string,
    _resourceId: string,
    _accountId: string,
    timeRange?: { startMs: number; endMs: number },
  ): Promise<MetricSeries[]> {
    if (resourceTypeId !== "billing-account") return [];
    return billingAccountSeries(this.ctx, rangeOrDefault(timeRange, METRICS_WINDOW_MS));
  }

  async fetchCostData(_accountId: string, range: CostFetchRange): Promise<CostRow[]> {
    return fetchGitHubCostData(this.ctx, range);
  }

  async verifyCredentials(): Promise<PreflightResult> {
    return verifyGitHubCredentials(this.ctx);
  }

  // -------------------------------------------------------------------------
  // Create / update / delete
  // -------------------------------------------------------------------------

  async getCreateConfig(typeId: string): Promise<CreateResourceConfig> {
    switch (typeId) {
      case "copilot-seat":
        return { fields: [await this.seatUserField()] };
      case "hosted-runner":
        return { fields: await this.hostedRunnerFields() };
      case "budget":
        return { fields: await this.budgetFields() };
      case "cost-center":
        return { fields: costCenterFields() };
      default:
        throw new Error(`GitHub plugin: cannot create "${typeId}" from Infrawrench`);
    }
  }

  private async seatUserField(): Promise<CreateFieldConfig> {
    if (!this.isOrg) {
      return {
        key: "login",
        label: "User",
        kind: "text",
        required: true,
        placeholder: "octocat",
        description: "The GitHub username of the enterprise member to give a Copilot seat.",
      };
    }
    const [members, seats] = await Promise.all([
      ghPaged<{ login?: string }>(
        this.ctx,
        `${ownerBase(this.ctx.owner)}/members`,
        (r) => r as { login?: string }[],
      ).catch(() => [] as Array<{ login?: string }>),
      ghPaged<GhCopilotSeat, { seats?: GhCopilotSeat[] }>(
        this.ctx,
        `${ownerBase(this.ctx.owner)}/copilot/billing/seats`,
        (r) => r.seats,
      ).catch(() => [] as GhCopilotSeat[]),
    ]);
    const seated = new Set(seats.map((s) => s.assignee?.login?.toLowerCase()).filter(Boolean));
    const options = members
      .map((m) => m.login)
      .filter((l): l is string => !!l && !seated.has(l.toLowerCase()))
      .sort((a, b) => a.localeCompare(b))
      .map((login) => ({ id: login, label: login }));
    return {
      key: "login",
      label: "Member",
      kind: "select",
      required: true,
      description:
        "Organization members without a seat. The seat is billed from today, prorated for the rest of the cycle. Seats can only be assigned this way when the organization assigns Copilot to selected members.",
      options,
    };
  }

  private async hostedRunnerFields(): Promise<CreateFieldConfig[]> {
    const base = ownerBase(this.ctx.owner);
    const [github, partner, sizes, groups] = await Promise.all([
      ghFetch<{
        images?: Array<{ id?: string; platform?: string; display_name?: string; size_gb?: number }>;
      }>(this.ctx, `${base}/actions/hosted-runners/images/github-owned`).catch(() => ({
        images: [],
      })),
      ghFetch<{
        images?: Array<{ id?: string; platform?: string; display_name?: string; size_gb?: number }>;
      }>(this.ctx, `${base}/actions/hosted-runners/images/partner`).catch(() => ({ images: [] })),
      ghFetch<{
        machine_specs?: Array<{
          id?: string;
          cpu_cores?: number;
          memory_gb?: number;
          storage_gb?: number;
        }>;
      }>(this.ctx, `${base}/actions/hosted-runners/machine-sizes`).catch(() => ({
        machine_specs: [],
      })),
      ghFetch<{ runner_groups?: Array<{ id?: number; name?: string; default?: boolean }> }>(
        this.ctx,
        `${base}/actions/runner-groups`,
        { query: { per_page: 100 } },
      ).catch(() => ({ runner_groups: [] })),
    ]);
    const images = [
      ...(github.images ?? []).map((i) => ({ ...i, source: "github" })),
      ...(partner.images ?? []).map((i) => ({ ...i, source: "partner" })),
    ].filter((i) => i.id);
    const defaultGroup =
      (groups.runner_groups ?? []).find((g) => g.default) ?? groups.runner_groups?.[0];
    return [
      {
        key: "name",
        label: "Name",
        kind: "text",
        required: true,
        placeholder: "ubuntu-8-core",
        description: "Workflows target the runner by this name in runs-on.",
      },
      {
        key: "image",
        label: "Image",
        kind: "select",
        required: true,
        options: images.map((i) => ({
          id: `${i.source}:${i.id}`,
          label: i.display_name || i.id!,
          description: [i.platform, i.source === "partner" ? "partner image" : ""]
            .filter(Boolean)
            .join(", "),
        })),
      },
      {
        key: "size",
        label: "Machine size",
        kind: "select",
        required: true,
        options: (sizes.machine_specs ?? [])
          .filter((s) => s.id)
          .sort((a, b) => (a.cpu_cores ?? 0) - (b.cpu_cores ?? 0))
          .map((s) => ({
            id: s.id!,
            label: `${s.cpu_cores ?? "?"} cores`,
            description: `${s.memory_gb ?? "?"} GB RAM, ${s.storage_gb ?? "?"} GB SSD`,
          })),
        description:
          "Billed per minute of job time at this size's rate. Larger sizes cost more per minute.",
      },
      {
        key: "runnerGroupId",
        label: "Runner group",
        kind: "select",
        required: true,
        ...(defaultGroup?.id !== undefined ? { defaultValue: String(defaultGroup.id) } : {}),
        options: (groups.runner_groups ?? [])
          .filter((g) => g.id !== undefined)
          .map((g) => ({ id: String(g.id), label: g.name ?? String(g.id) })),
      },
      {
        key: "maximumRunners",
        label: "Maximum concurrent jobs",
        kind: "number",
        required: false,
        defaultValue: "10",
        minValue: 1,
        description:
          "Caps how many jobs run on this runner at once, and so the most it can cost per minute.",
      },
      {
        key: "enableStaticIp",
        label: "Static public IP",
        kind: "select",
        required: false,
        defaultValue: "false",
        options: [
          { id: "false", label: "No" },
          { id: "true", label: "Yes", description: "A fixed IP range for allowlisting" },
        ],
      },
    ];
  }

  private async budgetFields(): Promise<CreateFieldConfig[]> {
    const centers = this.isOrg ? [] : await this.costCenters().catch(() => [] as CostCenter[]);
    const repos = this.isOrg
      ? await ghPaged<{ full_name?: string; name?: string }>(
          this.ctx,
          `${ownerBase(this.ctx.owner)}/repos`,
          (r) => r as Array<{ full_name?: string; name?: string }>,
          { sort: "full_name" },
          10,
        ).catch(() => [] as Array<{ full_name?: string; name?: string }>)
      : [];
    const scopes = this.isOrg
      ? [
          { id: "organization", label: "The whole organization" },
          { id: "repository", label: "One repository" },
          {
            id: "multi_user_customer",
            label: "Every user, each",
            description: "AI credits and premium requests only",
          },
          { id: "user", label: "One user", description: "AI credits and premium requests only" },
        ]
      : [
          { id: "enterprise", label: "The whole enterprise" },
          { id: "organization", label: "One organization" },
          { id: "repository", label: "One repository" },
          { id: "cost_center", label: "One cost centre" },
          {
            id: "multi_user_customer",
            label: "Every user, each",
            description: "AI credits and premium requests only",
          },
          { id: "user", label: "One user", description: "AI credits and premium requests only" },
        ];
    const fields: CreateFieldConfig[] = [
      {
        key: "product",
        label: "Product or SKU",
        kind: "select",
        required: true,
        defaultValue: "product:actions",
        options: budgetProductOptions(),
        description: "What the budget covers: a whole product, one SKU, or all AI credits.",
      },
      {
        key: "scope",
        label: "Applies to",
        kind: "select",
        required: true,
        defaultValue: this.isOrg ? "organization" : "enterprise",
        options: scopes,
      },
    ];
    if (repos.length > 0) {
      fields.push({
        key: "repository",
        label: "Repository",
        kind: "select",
        required: true,
        showWhen: { fieldKey: "scope", fieldValue: "repository" },
        options: repos
          .filter((r) => r.full_name)
          .map((r) => ({ id: r.full_name!, label: r.full_name! })),
      });
    } else {
      fields.push({
        key: "repository",
        label: "Repository",
        kind: "text",
        required: true,
        placeholder: "owner/name",
        showWhen: { fieldKey: "scope", fieldValue: "repository" },
      });
    }
    if (!this.isOrg) {
      fields.push(
        {
          key: "organization",
          label: "Organization",
          kind: "text",
          required: true,
          placeholder: "octo-org",
          showWhen: { fieldKey: "scope", fieldValue: "organization" },
        },
        {
          key: "costCenter",
          label: "Cost centre",
          kind: "select",
          required: true,
          showWhen: { fieldKey: "scope", fieldValue: "cost_center" },
          options: centers.map((c) => ({ id: c.name ?? c.id!, label: c.name ?? c.id! })),
        },
      );
    }
    fields.push(
      {
        key: "user",
        label: "User",
        kind: "text",
        required: true,
        placeholder: "octocat",
        showWhen: { fieldKey: "scope", fieldValue: "user" },
      },
      {
        key: "budgetAmount",
        label: "Amount (USD)",
        kind: "number",
        required: true,
        minValue: 0,
        stepValue: 1,
        description: "Whole dollars per month. For licence-based products, the number of licences.",
      },
      {
        key: "preventFurtherUsage",
        label: "When exceeded",
        kind: "select",
        required: true,
        defaultValue: "false",
        options: [
          { id: "false", label: "Alert only", description: "Usage continues and is billed" },
          { id: "true", label: "Stop usage", description: "Required for per-user budgets" },
        ],
      },
      {
        key: "willAlert",
        label: "Send alerts",
        kind: "select",
        required: false,
        defaultValue: "true",
        options: [
          { id: "true", label: "Yes", description: "At 75%, 90% and 100% of the budget" },
          { id: "false", label: "No" },
        ],
        showWhen: { fieldKey: "scope", fieldValuesNot: ["user"] },
      },
      {
        key: "alertRecipients",
        label: "Alert recipients",
        kind: "string-list",
        required: false,
        placeholder: "octocat",
        description: "GitHub usernames of billing managers or owners to notify.",
        showWhen: { fieldKey: "scope", fieldValuesNot: ["user"] },
      },
      {
        key: "expiresAt",
        label: "Expires",
        kind: "datetime",
        datetimeMode: "date",
        required: false,
        description: "Optional. Only user budgets can expire.",
        showWhen: { fieldKey: "scope", fieldValue: "user" },
      },
    );
    return fields;
  }

  async createResource(
    typeId: string,
    accountId: string,
    fields: Record<string, string>,
  ): Promise<ResourceInstance> {
    this.invalidate();
    switch (typeId) {
      case "copilot-seat": {
        const login = (fields["login"] ?? "").trim();
        if (!login) throw new Error("Choose a member to give a Copilot seat.");
        await ghFetch<unknown>(
          this.ctx,
          `${ownerBase(this.ctx.owner)}/copilot/billing/selected_users`,
          {
            method: "POST",
            body: { selected_usernames: [login] },
          },
        );
        const seats = await this.listSeats(accountId).catch(() => [] as ResourceInstance[]);
        return (
          seats.find((s) => (s.externalId ?? "").toLowerCase() === login.toLowerCase()) ??
          mapCopilotSeat(
            accountId,
            { assignee: { login }, created_at: new Date().toISOString() },
            undefined,
          )
        );
      }
      case "hosted-runner": {
        const [source, ...rest] = (fields["image"] ?? "").split(":");
        const created = await ghFetch<GhHostedRunner>(
          this.ctx,
          `${ownerBase(this.ctx.owner)}/actions/hosted-runners`,
          {
            method: "POST",
            body: {
              name: (fields["name"] ?? "").trim(),
              image: { id: rest.join(":"), source: source || "github" },
              size: fields["size"],
              runner_group_id: Number(fields["runnerGroupId"]),
              ...(fields["maximumRunners"]
                ? { maximum_runners: Number(fields["maximumRunners"]) }
                : {}),
              enable_static_ip: yes(fields["enableStaticIp"]),
            },
          },
        );
        return mapHostedRunner(accountId, created, await this.skuSpend());
      }
      case "budget": {
        const created = await ghFetch<{ budget?: GhBudget } & GhBudget>(
          this.ctx,
          `${billingBase(this.ctx.owner)}/budgets`,
          { method: "POST", body: buildBudgetBody(fields) },
        );
        const budget = created.budget ?? created;
        return mapBudget(accountId, budget, undefined);
      }
      case "cost-center": {
        const created = await ghFetch<CostCenter>(
          this.ctx,
          `${billingBase(this.ctx.owner)}/cost-centers`,
          {
            method: "POST",
            body: {
              name: (fields["name"] ?? "").trim(),
              ...(fields["aiCreditPoolEnabled"]
                ? { ai_credit_pool_enabled: yes(fields["aiCreditPoolEnabled"]) }
                : {}),
            },
          },
        );
        const add = memberBody(fields);
        if (created.id && add) {
          await ghFetch<unknown>(
            this.ctx,
            `${billingBase(this.ctx.owner)}/cost-centers/${encodeURIComponent(created.id)}/resource`,
            { method: "POST", body: add },
          );
        }
        return mapCostCenter(
          accountId,
          { ...created, resources: membersToResources(fields) },
          undefined,
        );
      }
      default:
        throw new Error(`GitHub plugin: cannot create "${typeId}" from Infrawrench`);
    }
  }

  async updateResource(
    typeId: string,
    resourceId: string,
    accountId: string,
    fields: Record<string, string>,
  ): Promise<ResourceInstance> {
    const id = externalIdOf(resourceId);
    this.invalidate();
    if (typeId === "hosted-runner") {
      const body: Record<string, unknown> = {};
      if ("name" in fields) body["name"] = (fields["name"] ?? "").trim();
      if ("maximumRunners" in fields && fields["maximumRunners"]) {
        body["maximum_runners"] = Number(fields["maximumRunners"]);
      }
      if ("enableStaticIp" in fields) body["enable_static_ip"] = yes(fields["enableStaticIp"]);
      const updated = await ghFetch<GhHostedRunner>(
        this.ctx,
        `${ownerBase(this.ctx.owner)}/actions/hosted-runners/${encodeURIComponent(id)}`,
        { method: "PATCH", body },
      );
      return mapHostedRunner(accountId, updated, await this.skuSpend());
    }
    if (typeId === "budget") {
      const current = await ghFetch<GhBudget>(
        this.ctx,
        `${billingBase(this.ctx.owner)}/budgets/${encodeURIComponent(id)}`,
      ).catch(() => undefined);
      const body: Record<string, unknown> = {};
      if ("budgetAmount" in fields)
        body["budget_amount"] = Math.round(Number(fields["budgetAmount"]));
      if ("preventFurtherUsage" in fields)
        body["prevent_further_usage"] = yes(fields["preventFurtherUsage"]);
      if ("willAlert" in fields || "alertRecipients" in fields) {
        body["budget_alerting"] = {
          will_alert:
            "willAlert" in fields
              ? yes(fields["willAlert"])
              : (current?.budget_alerting?.will_alert ?? false),
          alert_recipients:
            "alertRecipients" in fields
              ? list(fields["alertRecipients"])
              : (current?.budget_alerting?.alert_recipients ?? []),
        };
      }
      if ("expiresAt" in fields && fields["expiresAt"])
        body["expires_at"] = fields["expiresAt"]!.slice(0, 10);
      await ghFetch<unknown>(
        this.ctx,
        `${billingBase(this.ctx.owner)}/budgets/${encodeURIComponent(id)}`,
        {
          method: "PATCH",
          body,
        },
      );
      return this.getResource("budget", resourceId, accountId);
    }
    if (typeId === "cost-center") {
      const path = `${billingBase(this.ctx.owner)}/cost-centers/${encodeURIComponent(id)}`;
      const patch: Record<string, unknown> = {};
      if ("name" in fields) patch["name"] = (fields["name"] ?? "").trim();
      if ("aiCreditPoolEnabled" in fields)
        patch["ai_credit_pool_enabled"] = yes(fields["aiCreditPoolEnabled"]);
      if (Object.keys(patch).length > 0) {
        await ghFetch<unknown>(this.ctx, path, { method: "PATCH", body: patch });
      }
      const memberKeys = ["users", "organizations", "repositories", "enterpriseTeams"] as const;
      if (memberKeys.some((k) => k in fields)) {
        const current = await ghFetch<CostCenter>(this.ctx, path);
        const now = costCenterMembers(current.resources);
        const add: Record<string, string[]> = {};
        const remove: Record<string, string[]> = {};
        const wire: Record<(typeof memberKeys)[number], string> = {
          users: "users",
          organizations: "organizations",
          repositories: "repositories",
          enterpriseTeams: "enterprise_teams",
        };
        for (const k of memberKeys) {
          if (!(k in fields)) continue;
          const want = new Set(list(fields[k]).map((s) => s.toLowerCase()));
          const have = new Map(now[k].map((s) => [s.toLowerCase(), s]));
          const toAdd = list(fields[k]).filter((s) => !have.has(s.toLowerCase()));
          const toRemove = [...have.entries()].filter(([lc]) => !want.has(lc)).map(([, s]) => s);
          if (toAdd.length) add[wire[k]] = toAdd;
          if (toRemove.length) remove[wire[k]] = toRemove;
        }
        if (Object.keys(remove).length > 0) {
          await ghFetch<unknown>(this.ctx, `${path}/resource`, { method: "DELETE", body: remove });
        }
        if (Object.keys(add).length > 0) {
          await ghFetch<unknown>(this.ctx, `${path}/resource`, { method: "POST", body: add });
        }
      }
      return this.getResource("cost-center", resourceId, accountId);
    }
    throw new Error(`GitHub plugin: "${typeId}" cannot be edited from Infrawrench`);
  }

  async deleteResource(typeId: string, resourceId: string, _accountId: string): Promise<void> {
    const id = externalIdOf(resourceId);
    const base = ownerBase(this.ctx.owner);
    this.invalidate();
    switch (typeId) {
      case "copilot-seat":
        return this.removeSeat(id);
      case "hosted-runner":
        await ghFetch<unknown>(
          this.ctx,
          `${base}/actions/hosted-runners/${encodeURIComponent(id)}`,
          {
            method: "DELETE",
          },
        );
        return;
      case "runner":
        await ghFetch<unknown>(this.ctx, `${base}/actions/runners/${encodeURIComponent(id)}`, {
          method: "DELETE",
        });
        return;
      case "codespace": {
        const { user, name } = splitCodespaceId(id);
        await ghFetch<unknown>(
          this.ctx,
          `${base}/members/${encodeURIComponent(user)}/codespaces/${encodeURIComponent(name)}`,
          { method: "DELETE" },
        );
        return;
      }
      case "budget":
        await ghFetch<unknown>(
          this.ctx,
          `${billingBase(this.ctx.owner)}/budgets/${encodeURIComponent(id)}`,
          {
            method: "DELETE",
          },
        );
        return;
      case "cost-center":
        await ghFetch<unknown>(
          this.ctx,
          `${billingBase(this.ctx.owner)}/cost-centers/${encodeURIComponent(id)}`,
          { method: "DELETE" },
        );
        return;
      default:
        throw new Error(`GitHub plugin: "${typeId}" cannot be deleted from Infrawrench`);
    }
  }

  /**
   * Sets the seat to "pending cancellation": the user keeps Copilot until the
   * end of the billing cycle and the seat is not billed after it. Only works
   * for seats assigned directly; a seat that comes from a team needs the team
   * changed instead, which GitHub reports as zero seats cancelled.
   */
  private async removeSeat(login: string): Promise<void> {
    const res = await ghFetch<{ seats_cancelled?: number }>(
      this.ctx,
      `${ownerBase(this.ctx.owner)}/copilot/billing/selected_users`,
      { method: "DELETE", body: { selected_usernames: [login] } },
    );
    if (res && res.seats_cancelled === 0) {
      throw new Error(
        `GitHub cancelled no seat for ${login}. The seat probably comes from a team: remove ${login} from that team, or the team from Copilot, in GitHub.`,
      );
    }
  }

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  async invokeAction(
    typeId: string,
    resourceId: string,
    actionId: string,
    _accountId: string,
  ): Promise<void> {
    const id = externalIdOf(resourceId);
    this.invalidate();
    if (typeId === "copilot-seat" && actionId === "remove-seat") return this.removeSeat(id);
    if (typeId === "actions-cache") {
      const repoPath = `/repos/${id.split("/").map(encodeURIComponent).join("/")}`;
      if (actionId.startsWith("delete-cache:")) {
        const cacheId = actionId.slice("delete-cache:".length);
        await ghFetch<unknown>(
          this.ctx,
          `${repoPath}/actions/caches/${encodeURIComponent(cacheId)}`,
          {
            method: "DELETE",
          },
        );
        return;
      }
      if (actionId === "delete-all-caches") {
        // There is no "delete everything" call; page through and delete by id.
        for (let round = 0; round < 50; round++) {
          const res = await ghFetch<{ actions_caches?: GhActionsCache[] }>(
            this.ctx,
            `${repoPath}/actions/caches`,
            { query: { per_page: 100 } },
          );
          const batch = (res.actions_caches ?? []).filter((c) => c.id !== undefined);
          if (batch.length === 0) return;
          for (const c of batch) {
            await ghFetch<unknown>(this.ctx, `${repoPath}/actions/caches/${c.id}`, {
              method: "DELETE",
            });
          }
        }
        return;
      }
    }
    if (typeId === "codespace" && actionId === "stop") {
      const { user, name } = splitCodespaceId(id);
      await ghFetch<unknown>(
        this.ctx,
        `${ownerBase(this.ctx.owner)}/members/${encodeURIComponent(user)}/codespaces/${encodeURIComponent(name)}/stop`,
        { method: "POST" },
      );
      return;
    }
    throw new Error(`GitHub plugin: unknown action "${actionId}" for "${typeId}"`);
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  renderDetail(resource: ResourceInstance): DetailViewSchema {
    return renderGitHubDetail(resource, { host: this.ctx.host, owner: this.ctx.owner });
  }

  renderSidebarItem(resource: ResourceInstance): SidebarItemSchema {
    return renderGitHubSidebar(resource);
  }
}

function splitCodespaceId(id: string): { user: string; name: string } {
  const slash = id.indexOf("/");
  if (slash <= 0) throw new Error(`GitHub plugin: malformed codespace id "${id}"`);
  return { user: id.slice(0, slash), name: id.slice(slash + 1) };
}

function costCenterFields(): CreateFieldConfig[] {
  return [
    { key: "name", label: "Name", kind: "text", required: true, placeholder: "Platform team" },
    {
      key: "users",
      label: "Users",
      kind: "string-list",
      required: false,
      placeholder: "octocat",
      description: "GitHub usernames whose seat and usage costs go to this cost centre.",
    },
    {
      key: "organizations",
      label: "Organizations",
      kind: "string-list",
      required: false,
      placeholder: "octo-org",
    },
    {
      key: "repositories",
      label: "Repositories",
      kind: "string-list",
      required: false,
      placeholder: "octo-org/app",
    },
    {
      key: "enterpriseTeams",
      label: "Enterprise teams",
      kind: "string-list",
      required: false,
      placeholder: "platform",
    },
    {
      key: "aiCreditPoolEnabled",
      label: "Draw from the AI credit pool",
      kind: "select",
      required: false,
      defaultValue: "false",
      options: [
        { id: "false", label: "No", description: "Draws from the shared enterprise pool" },
        {
          id: "true",
          label: "Yes",
          description: "Capped at its members' entitlements; users and teams only",
        },
      ],
    },
  ];
}

function memberBody(fields: Record<string, string>): Record<string, string[]> | undefined {
  const body: Record<string, string[]> = {};
  if (list(fields["users"]).length) body["users"] = list(fields["users"]);
  if (list(fields["organizations"]).length) body["organizations"] = list(fields["organizations"]);
  if (list(fields["repositories"]).length) body["repositories"] = list(fields["repositories"]);
  if (list(fields["enterpriseTeams"]).length)
    body["enterprise_teams"] = list(fields["enterpriseTeams"]);
  return Object.keys(body).length > 0 ? body : undefined;
}

function membersToResources(fields: Record<string, string>): Array<{ type: string; name: string }> {
  return [
    ...list(fields["users"]).map((name) => ({ type: "User", name })),
    ...list(fields["organizations"]).map((name) => ({ type: "Org", name })),
    ...list(fields["repositories"]).map((name) => ({ type: "Repo", name })),
    ...list(fields["enterpriseTeams"]).map((name) => ({ type: "Team", name })),
  ];
}

/** The create body for `POST {billing}/budgets` from the form's picks. */
export function buildBudgetBody(fields: Record<string, string>): Record<string, unknown> {
  const { type, sku } = parseBudgetProduct(fields["product"] ?? "");
  const scope = (fields["scope"] ?? "organization").trim();
  const entity =
    scope === "repository"
      ? fields["repository"]
      : scope === "organization"
        ? fields["organization"]
        : scope === "cost_center"
          ? fields["costCenter"]
          : undefined;
  const user = scope === "user" ? (fields["user"] ?? "").trim() : undefined;
  const perUser = scope === "user" || scope === "multi_user_customer";
  if (perUser && !(sku === "ai_credits" || sku === "premium_requests")) {
    throw new Error("Per-user budgets can only cover AI credits or premium requests.");
  }
  const body: Record<string, unknown> = {
    budget_type: type,
    budget_product_sku: sku,
    budget_scope: scope,
    budget_amount: Math.round(Number(fields["budgetAmount"] ?? 0)),
    // GitHub requires stop-usage for per-user budgets.
    prevent_further_usage: perUser ? true : yes(fields["preventFurtherUsage"]),
    ...(entity ? { budget_entity_name: entity.trim() } : {}),
    ...(user ? { user } : {}),
  };
  if (scope !== "user") {
    body["budget_alerting"] = {
      will_alert: fields["willAlert"] === undefined ? true : yes(fields["willAlert"]),
      alert_recipients: list(fields["alertRecipients"]),
    };
  } else if (fields["expiresAt"]) {
    body["expires_at"] = fields["expiresAt"].slice(0, 10);
  }
  return body;
}
