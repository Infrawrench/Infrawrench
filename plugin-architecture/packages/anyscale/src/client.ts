import type {
  CostFetchRange,
  CostRow,
  CreateResourceConfig,
  CreditBalance,
  DashboardStat,
  DetailViewSchema,
  HostServices,
  MetricSeries,
  PluginClient,
  ResourceInstance,
  SidebarItemSchema,
} from "@infrawrench/plugin-base";
import { externalIdOf } from "@infrawrench/plugin-base";
import type { AnyscaleContext } from "./api.js";
import { anyscaleFetch, anyscalePaged, statusOf } from "./api.js";
import {
  fetchAnyscaleCostData,
  fetchTotalUsage,
  fetchUsageBreakdown,
  fetchWorkloadSpend,
} from "./cost-data.js";
import { creditBalances, fetchCredits } from "./credits.js";
import {
  mapBudget,
  mapCloud,
  mapComputeConfig,
  mapJob,
  mapOrganization,
  mapProject,
  mapService,
  mapWorkspace,
} from "./mappers.js";
import {
  DEFAULT_METRICS_WINDOW_MS,
  SPEND_METRICS_WINDOW_MS,
  dailySpendSeries,
  nodeHours,
  rangeOrDefault,
  utilizationSeries,
} from "./metrics.js";
import type { CreditLine, CreditSummary, OrgBreakdown, WorkloadSpend } from "./render.js";
import {
  BREAKDOWN_KEY,
  CREDITS_KEY,
  SPEND_KEY,
  renderAnyscaleDetail,
  renderAnyscaleSidebar,
} from "./render.js";
import type {
  AsBudget,
  AsCloud,
  AsCluster,
  AsComputeConfig,
  AsCreditRecord,
  AsCredits,
  AsJob,
  AsProject,
  AsService,
  AsUserInfo,
  AsWorkspace,
} from "./types.js";

const RUNNING_CLUSTER_STATES = ["Running", "Updating", "StartingUp", "AwaitingStartup"];

const isoDay = (d: Date) => d.toISOString().slice(0, 10);

function monthStart(now = new Date()): string {
  return `${now.toISOString().slice(0, 7)}-01`;
}

export class AnyscaleClient implements PluginClient {
  private readonly ctx: AnyscaleContext;

  constructor(credentials: Record<string, string>, services?: HostServices) {
    const apiKey = (credentials["apiKey"] ?? "").trim();
    if (!apiKey) throw new Error("Anyscale plugin: missing apiKey credential");
    this.ctx = { apiKey, ...(services?.http ? { http: services.http } : {}) };
  }

  // -------------------------------------------------------------------------
  // Raw reads
  // -------------------------------------------------------------------------

  private userInfo(): Promise<AsUserInfo> {
    return anyscaleFetch<{ result?: AsUserInfo }>(this.ctx, "/api/v2/userinfo/").then(
      (r) => r.result ?? {},
    );
  }

  private clouds(): Promise<AsCloud[]> {
    return anyscalePaged<AsCloud>(this.ctx, "/api/v2/clouds/", { count: 1000, maxPages: 5 });
  }

  private projects(): Promise<AsProject[]> {
    return anyscalePaged<AsProject>(this.ctx, "/api/v2/projects/", {
      query: { include_defaults: true },
      count: 50,
      maxPages: 40,
    });
  }

  /** Clusters that are up (or coming up), user-visible ones only. */
  private async runningClusters(): Promise<AsCluster[]> {
    const all = await anyscalePaged<AsCluster>(this.ctx, "/api/v2/decorated_sessions/", {
      query: { state_filter: RUNNING_CLUSTER_STATES },
      count: 50,
      maxPages: 40,
    });
    return all.filter((c) => !c.is_system_cluster);
  }

  private workspaces(): Promise<AsWorkspace[]> {
    return anyscalePaged<AsWorkspace>(this.ctx, "/api/v2/experimental_workspaces/", {
      count: 50,
      maxPages: 40,
    });
  }

  /** Batch jobs only (services are listed from their own route), newest first. */
  private jobs(): Promise<AsJob[]> {
    return anyscalePaged<AsJob>(this.ctx, "/api/v2/decorated_ha_jobs/", {
      query: { type_filter: "BATCH_JOB" },
      count: 100,
      maxPages: 10,
    });
  }

  private services(): Promise<AsService[]> {
    return anyscalePaged<AsService>(this.ctx, "/api/v2/services-v2/", { count: 50, maxPages: 20 });
  }

  /** Latest version of every named, unarchived compute config. */
  private computeConfigs(): Promise<AsComputeConfig[]> {
    return anyscalePaged<AsComputeConfig>(this.ctx, "/api/v2/compute_templates/search", {
      body: { include_anonymous: false, archive_status: "NOT_ARCHIVED" },
      count: 100,
      maxPages: 20,
    });
  }

  private budgets(): Promise<AsBudget[]> {
    return anyscalePaged<AsBudget>(this.ctx, "/api/v2/instance_usage_budgets/", {
      count: 50,
      maxPages: 20,
    });
  }

  // -------------------------------------------------------------------------
  // Listing
  // -------------------------------------------------------------------------

  /**
   * A 403 on one list means the key's role cannot see that kind of object
   * (budgets are owner-only, for instance); the rest of the account still
   * works, so that type lists empty rather than failing the sync.
   */
  private async scoped(load: () => Promise<ResourceInstance[]>): Promise<ResourceInstance[]> {
    try {
      return await load();
    } catch (err) {
      if (statusOf(err) === 403) return [];
      throw err;
    }
  }

  async listResources(typeId: string, accountId: string): Promise<ResourceInstance[]> {
    switch (typeId) {
      case "organization":
        return this.listOrganization(accountId, false);
      case "cloud":
        return this.scoped(async () => {
          const [clouds, running] = await Promise.all([
            this.clouds(),
            this.runningClusters().catch(() => undefined),
          ]);
          return clouds.map((c) =>
            mapCloud(
              accountId,
              c,
              running
                ? running.filter((k) => (k.cloud_id ?? k.cloud?.id) === c.id).length
                : undefined,
            ),
          );
        });
      case "project":
        return this.scoped(async () => {
          const [projects, clouds] = await Promise.all([
            this.projects(),
            this.clouds().catch(() => [] as AsCloud[]),
          ]);
          const names = new Map(clouds.map((c) => [c.id ?? "", c.name ?? ""]));
          return projects.map((p) => mapProject(accountId, p, names));
        });
      case "workspace":
        return this.scoped(async () => {
          const [workspaces, running, projects] = await Promise.all([
            this.workspaces(),
            this.runningClusters().catch(() => [] as AsCluster[]),
            this.projects().catch(() => [] as AsProject[]),
          ]);
          const clusters = new Map(running.map((c) => [c.id ?? "", c]));
          const projectNames = new Map(projects.map((p) => [p.id ?? "", p.name ?? ""]));
          return workspaces
            .filter((w) => !w.is_deleted)
            .map((w) => mapWorkspace(accountId, w, clusters.get(w.cluster_id ?? ""), projectNames));
        });
      case "job":
        return this.scoped(async () =>
          (await this.jobs()).filter((j) => !j.archived_at).map((j) => mapJob(accountId, j)),
        );
      case "service":
        return this.scoped(async () =>
          (await this.services()).map((s) => mapService(accountId, s)),
        );
      case "compute-config":
        return this.scoped(async () =>
          (await this.computeConfigs())
            .filter((c) => !c.anonymous && !c.archived_at)
            .map((c) => mapComputeConfig(accountId, c)),
        );
      case "budget":
        return this.scoped(async () => (await this.budgets()).map((b) => mapBudget(accountId, b)));
      default:
        throw new Error(`Anyscale plugin: unknown resource type "${typeId}"`);
    }
  }

  /**
   * The organization row. Spend and credit balance come from owner-only
   * billing routes; for anyone else they are simply absent.
   */
  private async listOrganization(
    accountId: string,
    withBilling: boolean,
  ): Promise<ResourceInstance[]> {
    const info = await this.userInfo();
    const org = info.organizations?.[0] ?? { name: "Anyscale organization" };
    const now = new Date();
    const [mtd, credits] = await Promise.all([
      fetchTotalUsage(this.ctx, monthStart(now), isoDay(now)).catch(() => undefined),
      withBilling ? fetchCredits(this.ctx).catch(() => undefined) : Promise.resolve(undefined),
    ]);
    return [
      mapOrganization(accountId, info, org, {
        ...(mtd ? { monthToDate: mtd.dollars } : {}),
        ...(credits && typeof credits.current_balance_usd === "number"
          ? { creditBalance: credits.current_balance_usd }
          : {}),
      }),
    ];
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
    const enc = encodeURIComponent(id);
    switch (typeId) {
      case "organization": {
        const [org] = await this.listOrganization(accountId, true);
        if (org) return org;
        break;
      }
      case "workspace": {
        const res = await anyscaleFetch<{ result?: AsWorkspace }>(
          this.ctx,
          `/api/v2/experimental_workspaces/${enc}`,
        );
        const w = res.result;
        if (!w) break;
        const cluster = w.cluster_id
          ? await anyscaleFetch<{ result?: AsCluster }>(
              this.ctx,
              `/api/v2/decorated_sessions/${encodeURIComponent(w.cluster_id)}`,
            )
              .then((r) => r.result)
              .catch(() => undefined)
          : undefined;
        const names = new Map<string, string>();
        if (cluster?.project?.id && cluster.project.name) {
          names.set(cluster.project.id, cluster.project.name);
        }
        return mapWorkspace(accountId, w, cluster, names);
      }
      case "job": {
        const res = await anyscaleFetch<{ result?: AsJob }>(
          this.ctx,
          `/api/v2/decorated_ha_jobs/${enc}`,
        );
        if (res.result) return mapJob(accountId, res.result);
        break;
      }
      case "service": {
        const res = await anyscaleFetch<{ result?: AsService }>(
          this.ctx,
          `/api/v2/services-v2/${enc}`,
        );
        if (res.result) return mapService(accountId, res.result);
        break;
      }
      case "budget": {
        const res = await anyscaleFetch<{ result?: AsBudget }>(
          this.ctx,
          `/api/v2/instance_usage_budgets/${enc}`,
        );
        if (res.result) return mapBudget(accountId, res.result);
        break;
      }
      case "compute-config": {
        const res = await anyscaleFetch<{ result?: AsComputeConfig }>(
          this.ctx,
          `/api/v2/compute_templates/${enc}`,
        );
        if (res.result) return mapComputeConfig(accountId, res.result);
        break;
      }
      default:
        break;
    }
    const all = await this.listResources(typeId, accountId);
    const found = all.find((r) => r.id === resourceId || r.externalId === id);
    if (!found) throw new Error(`Anyscale plugin: resource ${typeId}/${resourceId} not found`);
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
    throw new Error(`Anyscale plugin: cannot resolve output "${outputKey}" for type "${typeId}"`);
  }

  /**
   * Detail-view extras, fetched only when someone opens the page: the
   * organization's spend breakdown and credit grants, and each workload's
   * spend over the last 30 days. All owner-only; absent for anyone else.
   */
  async enrichDetail(resource: ResourceInstance): Promise<ResourceInstance> {
    const now = new Date();
    const today = isoDay(now);
    if (resource.resourceTypeId === "organization") {
      const from = monthStart(now);
      const [byType, byProject, byUser, credits] = await Promise.all([
        fetchUsageBreakdown(this.ctx, "cluster_type", from, today).catch(() => undefined),
        fetchUsageBreakdown(this.ctx, "project", from, today).catch(() => undefined),
        fetchUsageBreakdown(this.ctx, "user", from, today).catch(() => undefined),
        fetchCredits(this.ctx).catch(() => undefined),
      ]);
      const extra: Record<string, string> = {};
      if (byType && byProject && byUser) {
        const breakdown: OrgBreakdown = {
          fromDate: from,
          toDate: today,
          byType,
          byProject,
          byUser,
        };
        extra[BREAKDOWN_KEY] = JSON.stringify(breakdown);
      }
      if (credits) extra[CREDITS_KEY] = JSON.stringify(summarizeCredits(credits));
      return { ...resource, resolvedOutputs: { ...resource.resolvedOutputs, ...extra } };
    }
    if (["workspace", "job", "service"].includes(resource.resourceTypeId)) {
      const id = resource.externalId ?? externalIdOf(resource.id);
      const from = isoDay(new Date(now.getTime() - SPEND_METRICS_WINDOW_MS));
      const rows = await fetchWorkloadSpend(this.ctx, resource.displayName, from, today).catch(
        () => undefined,
      );
      if (!rows) return resource;
      const spend: WorkloadSpend = { fromDate: from, dollars: 0, credits: 0 };
      for (const r of rows) {
        if (r.workspace_id !== id && r.job_id !== id && r.service_id !== id) continue;
        spend.dollars += Number(r.dollar_value ?? 0);
        spend.credits += Number(r.anyscale_credits ?? 0);
      }
      return {
        ...resource,
        resolvedOutputs: { ...resource.resolvedOutputs, [SPEND_KEY]: JSON.stringify(spend) },
      };
    }
    return resource;
  }

  // -------------------------------------------------------------------------
  // Stats, metrics, costs, credits
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
      case "organization":
        return [
          { label: "Month to Date", value: usd(f["monthToDate"]) },
          { label: "Credit Balance", value: usd(f["creditBalance"]) },
        ];
      case "cloud": {
        const cloudId = String(f["cloudId"] ?? "");
        const series = await utilizationSeries(
          this.ctx,
          cloudId,
          rangeOrDefault(undefined, DEFAULT_METRICS_WINDOW_MS),
        ).catch(() => [] as MetricSeries[]);
        const running = await this.runningClusters().catch(() => undefined);
        const count = running?.filter((k) => (k.cloud_id ?? k.cloud?.id) === cloudId).length;
        return [
          { label: "Running Clusters", value: count === undefined ? "—" : String(count) },
          {
            label: "Node Hours (24h)",
            value: series.length ? nodeHours(series).toFixed(1) : "—",
          },
        ];
      }
      case "workspace":
        return [
          { label: "State", value: String(f["state"] ?? "—") },
          {
            label: "Activity",
            value: String(f["activity"] ?? "—"),
            variant: f["idle"] === "yes" ? "status-degraded" : "default",
          },
        ];
      case "job":
        return [
          { label: "State", value: String(f["state"] ?? "—") },
          { label: "Last Run", value: String(f["lastRunStatus"] ?? "—") },
        ];
      case "service":
        return [
          { label: "State", value: String(f["state"] ?? "—") },
          { label: "Version", value: String(f["primaryVersion"] ?? "—") },
        ];
      case "budget":
        return [
          {
            label: "Used",
            value: f["percentUsed"] !== undefined ? `${String(f["percentUsed"])}%` : "—",
            variant:
              typeof f["percentUsed"] === "number" && f["percentUsed"] >= 100
                ? "status-error"
                : "default",
          },
          { label: "Period", value: String(f["evaluationPeriod"] ?? "—") },
        ];
      default:
        return [];
    }
  }

  async fetchMetricSeries(
    resourceTypeId: string,
    resourceId: string,
    accountId: string,
    timeRange?: { startMs: number; endMs: number },
  ): Promise<MetricSeries[]> {
    const id = externalIdOf(resourceId);
    switch (resourceTypeId) {
      case "organization":
        return dailySpendSeries(this.ctx, rangeOrDefault(timeRange, SPEND_METRICS_WINDOW_MS));
      case "cloud":
        return utilizationSeries(
          this.ctx,
          id,
          rangeOrDefault(timeRange, DEFAULT_METRICS_WINDOW_MS),
        );
      case "project": {
        const p = await this.getResource("project", resourceId, accountId);
        return utilizationSeries(
          this.ctx,
          String(p.fields["cloudId"] ?? ""),
          rangeOrDefault(timeRange, DEFAULT_METRICS_WINDOW_MS),
          id,
        );
      }
      default:
        return [];
    }
  }

  async fetchCostData(_accountId: string, range: CostFetchRange): Promise<CostRow[]> {
    return fetchAnyscaleCostData(this.ctx, range);
  }

  async fetchCreditBalance(_accountId: string): Promise<CreditBalance[]> {
    return creditBalances(await fetchCredits(this.ctx));
  }

  // -------------------------------------------------------------------------
  // Create / update / delete
  // -------------------------------------------------------------------------

  async getCreateConfig(typeId: string): Promise<CreateResourceConfig> {
    if (typeId === "project") {
      const clouds = await this.clouds().catch(() => [] as AsCloud[]);
      const def = clouds.find((c) => c.is_default) ?? clouds[0];
      return {
        fields: [
          { key: "name", label: "Name", kind: "text", required: true, placeholder: "my-project" },
          {
            key: "cloudId",
            label: "Cloud",
            kind: "select",
            required: true,
            description: "Workloads in the project launch clusters in this cloud.",
            ...(def?.id ? { defaultValue: def.id } : {}),
            options: clouds
              .filter((c) => c.id)
              .map((c) => ({
                id: c.id as string,
                label: c.name ?? (c.id as string),
                description: [c.provider, c.region, c.is_aioa ? "Anyscale-hosted" : ""]
                  .filter(Boolean)
                  .join(" · "),
              })),
          },
          {
            key: "description",
            label: "Description",
            kind: "text",
            required: false,
            multiline: true,
          },
        ],
      };
    }
    if (typeId === "budget") {
      const [clouds, projects] = await Promise.all([
        this.clouds().catch(() => [] as AsCloud[]),
        this.projects().catch(() => [] as AsProject[]),
      ]);
      const cloudName = new Map(clouds.map((c) => [c.id ?? "", c.name ?? c.id ?? ""]));
      return {
        fields: [
          { key: "name", label: "Name", kind: "text", required: true, placeholder: "Monthly cap" },
          {
            key: "scope",
            label: "Applies to",
            kind: "select",
            required: true,
            defaultValue: "org",
            description:
              "Anyscale allows one daily and one monthly budget per cloud and project combination.",
            options: [
              { id: "org", label: "Whole organization" },
              ...clouds
                .filter((c) => c.id)
                .map((c) => ({ id: `cloud:${c.id}`, label: `Cloud: ${c.name ?? c.id}` })),
              ...projects
                .filter((p) => p.id && (p.parent_cloud_id ?? p.cloud_id))
                .map((p) => {
                  const cloudId = (p.parent_cloud_id ?? p.cloud_id) as string;
                  return {
                    id: `project:${cloudId}:${p.id}`,
                    label: `Project: ${p.name ?? p.id}`,
                    description: cloudName.get(cloudId) ?? cloudId,
                  };
                }),
            ],
          },
          {
            key: "budgetAmount",
            label: "Amount",
            kind: "number",
            required: true,
            minValue: 0,
            stepValue: 1,
          },
          {
            key: "budgetUnit",
            label: "Unit",
            kind: "select",
            required: true,
            defaultValue: "DOLLARS",
            options: [
              { id: "DOLLARS", label: "US dollars" },
              { id: "ANYSCALE_CREDITS", label: "Anyscale credits" },
            ],
          },
          {
            key: "evaluationPeriod",
            label: "Period",
            kind: "select",
            required: true,
            defaultValue: "MONTHLY",
            options: [
              { id: "MONTHLY", label: "Monthly", description: "Resets on the 1st, UTC" },
              { id: "DAILY", label: "Daily", description: "Resets at midnight UTC" },
            ],
          },
        ],
      };
    }
    throw new Error(`Anyscale plugin: cannot create "${typeId}" from Infrawrench`);
  }

  async createResource(
    typeId: string,
    accountId: string,
    fields: Record<string, string>,
  ): Promise<ResourceInstance> {
    if (typeId === "project") {
      const cloudId = (fields["cloudId"] ?? "").trim();
      const res = await anyscaleFetch<{ result?: AsProject }>(this.ctx, "/api/v2/projects/", {
        method: "POST",
        body: JSON.stringify({
          name: (fields["name"] ?? "").trim(),
          description: fields["description"] ?? "",
          ...(cloudId ? { cloud_id: cloudId, parent_cloud_id: cloudId } : {}),
        }),
      });
      if (!res.result) throw new Error("Anyscale plugin: project create returned nothing");
      return mapProject(accountId, res.result, new Map());
    }
    if (typeId === "budget") {
      const [kind, a, b] = (fields["scope"] ?? "org").split(":");
      const scope =
        kind === "cloud" && a
          ? { cloud_id: a }
          : kind === "project" && a && b
            ? { cloud_id: a, project_id: b }
            : {};
      const res = await anyscaleFetch<{ result?: AsBudget }>(
        this.ctx,
        "/api/v2/instance_usage_budgets/",
        {
          method: "POST",
          body: JSON.stringify({
            name: (fields["name"] ?? "").trim(),
            budget_amount: Number(fields["budgetAmount"] ?? 0),
            budget_unit: fields["budgetUnit"] || "DOLLARS",
            evaluation_period: fields["evaluationPeriod"] || "MONTHLY",
            ...scope,
          }),
        },
      );
      if (!res.result) throw new Error("Anyscale plugin: budget create returned nothing");
      return mapBudget(accountId, res.result);
    }
    throw new Error(`Anyscale plugin: cannot create "${typeId}" from Infrawrench`);
  }

  async updateResource(
    typeId: string,
    resourceId: string,
    accountId: string,
    fields: Record<string, string>,
  ): Promise<ResourceInstance> {
    if (typeId !== "budget") {
      throw new Error(`Anyscale plugin: "${typeId}" cannot be edited from Infrawrench`);
    }
    const res = await anyscaleFetch<{ result?: AsBudget }>(
      this.ctx,
      `/api/v2/instance_usage_budgets/${encodeURIComponent(externalIdOf(resourceId))}`,
      {
        method: "PUT",
        query: {
          budget_amount: fields["budgetAmount"] || undefined,
          evaluation_period: fields["evaluationPeriod"] || undefined,
          budget_unit: fields["budgetUnit"] || undefined,
        },
      },
    );
    if (res.result) return mapBudget(accountId, res.result);
    return this.getResource(typeId, resourceId, accountId);
  }

  async deleteResource(typeId: string, resourceId: string, _accountId: string): Promise<void> {
    const id = encodeURIComponent(externalIdOf(resourceId));
    switch (typeId) {
      case "project":
        await anyscaleFetch<unknown>(this.ctx, `/api/v2/projects/${id}`, { method: "DELETE" });
        return;
      case "compute-config":
        // Archiving is Anyscale's delete: every version is hidden and can no
        // longer launch new clusters; clusters already using it keep running.
        await anyscaleFetch<unknown>(this.ctx, `/api/v2/compute_templates/${id}/archive`, {
          method: "POST",
        });
        return;
      case "budget":
        await anyscaleFetch<unknown>(this.ctx, `/api/v2/instance_usage_budgets/${id}`, {
          method: "DELETE",
        });
        return;
      default:
        throw new Error(`Anyscale plugin: "${typeId}" cannot be deleted from Infrawrench`);
    }
  }

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  async invokeAction(
    typeId: string,
    resourceId: string,
    actionId: string,
    accountId: string,
  ): Promise<void> {
    const id = externalIdOf(resourceId);
    const enc = encodeURIComponent(id);
    if (typeId === "workspace" && (actionId === "start" || actionId === "terminate")) {
      const w = await this.getResource("workspace", resourceId, accountId);
      const clusterId = String(w.fields["clusterId"] ?? "");
      if (!clusterId) throw new Error("This workspace has no cluster to start or terminate.");
      const path = `/api/v2/sessions/${encodeURIComponent(clusterId)}/${actionId === "start" ? "start" : "stop"}`;
      // The same options `anyscale workspace_v2 start|terminate` send.
      const body =
        actionId === "start"
          ? {}
          : { terminate: true, workers_only: false, keep_min_workers: false, take_snapshot: false };
      await anyscaleFetch<unknown>(this.ctx, path, { method: "POST", body: JSON.stringify(body) });
      return;
    }
    if (typeId === "job" && actionId === "terminate") {
      await anyscaleFetch<unknown>(this.ctx, `/api/v2/decorated_ha_jobs/${enc}/terminate`, {
        method: "POST",
      });
      return;
    }
    if (typeId === "service" && actionId === "terminate") {
      await anyscaleFetch<unknown>(this.ctx, `/api/v2/services-v2/${enc}/terminate`, {
        method: "POST",
      });
      return;
    }
    if (typeId === "service" && actionId === "rollback") {
      await anyscaleFetch<unknown>(this.ctx, `/api/v2/services-v2/${enc}/rollback`, {
        method: "POST",
        body: "{}",
      });
      return;
    }
    if (typeId === "budget" && (actionId === "enable" || actionId === "disable")) {
      await anyscaleFetch<unknown>(
        this.ctx,
        `/api/v2/instance_usage_budgets/${enc}/toggle_is_enabled`,
        {
          method: "POST",
          query: { is_enabled: actionId === "enable" },
        },
      );
      return;
    }
    throw new Error(`Anyscale plugin: unknown action "${actionId}" for "${typeId}"`);
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  renderDetail(resource: ResourceInstance): DetailViewSchema {
    return renderAnyscaleDetail(resource);
  }

  renderSidebarItem(resource: ResourceInstance): SidebarItemSchema {
    return renderAnyscaleSidebar(resource);
  }
}

function creditLines(
  records: AsCreditRecord[] | undefined,
  kind: CreditLine["kind"],
  status: CreditLine["status"],
): CreditLine[] {
  return (records ?? []).map((r) => ({
    name: r.contract_name ? `${r.credit_name ?? ""} (${r.contract_name})` : (r.credit_name ?? ""),
    kind,
    status,
    balance: Number(r.total_balance_usd ?? 0),
    granted: Number(r.total_granted_usd ?? 0),
    start: r.effective_date_start ?? "",
    end: r.effective_date_end ?? "",
  }));
}

export function summarizeCredits(c: AsCredits): CreditSummary {
  return {
    balance: Number(c.current_balance_usd ?? 0),
    spent: Number(c.amount_spent_usd ?? 0),
    granted: Number(c.total_granted_usd ?? 0),
    lines: [
      ...creditLines(c.in_use_credits, "Credit", "In use"),
      ...creditLines(c.in_use_commits, "Commit", "In use"),
      ...creditLines(c.pending_credits, "Credit", "Pending"),
      ...creditLines(c.pending_commits, "Commit", "Pending"),
      ...creditLines(c.expired_credits, "Credit", "Expired"),
      ...creditLines(c.expired_commits, "Commit", "Expired"),
    ],
  };
}
