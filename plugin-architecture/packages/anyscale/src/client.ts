import type { Credentials } from "./plugin.js";
import { attempt, runPluginEffect } from "@infrawrench/plugin-base/effect";
import type { PluginEffect } from "@infrawrench/plugin-base";
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
import { externalIdOf, pathEncode } from "@infrawrench/plugin-base";
import type {
  AnyscaleApi,
  AsBudget,
  AsCloud,
  AsCluster,
  AsComputeConfig,
  AsCreditRecord,
  AsCredits,
  AsJob,
  AsProject,
  AsService,
  AsSessionState,
  AsUserInfo,
  AsWorkspace,
} from "./api.js";
import { createAnyscaleApi, listPages, statusOf } from "./api.js";
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

const RUNNING_CLUSTER_STATES: AsSessionState[] = [
  "Running",
  "Updating",
  "StartingUp",
  "AwaitingStartup",
];

const isoDay = (d: Date) => d.toISOString().slice(0, 10);

function monthStart(now = new Date()): string {
  return `${now.toISOString().slice(0, 7)}-01`;
}

export class AnyscaleClient implements PluginClient {
  private readonly api: AnyscaleApi;

  constructor(credentials: Credentials, services?: HostServices) {
    const apiKey = (credentials["apiKey"] ?? "").trim();
    if (!apiKey) throw new Error("Anyscale plugin: missing apiKey credential");
    this.api = createAnyscaleApi({ apiKey, http: services?.http });
  }

  // -------------------------------------------------------------------------
  // Raw reads
  // -------------------------------------------------------------------------

  private userInfo(): Promise<AsUserInfo> {
    return this.api.get("/api/v2/userinfo/").then((r) => r.result ?? {});
  }

  private clouds(): Promise<AsCloud[]> {
    return listPages(5, 1000, (query) => this.api.get("/api/v2/clouds/", { query }));
  }

  private projects(): Promise<AsProject[]> {
    return listPages(40, 50, (query) =>
      this.api.get("/api/v2/projects/", { query: { include_defaults: true, ...query } }),
    );
  }

  /** Clusters that are up (or coming up), user-visible ones only. */
  private async runningClusters(): Promise<AsCluster[]> {
    const all = await listPages(40, 50, (query) =>
      this.api.get("/api/v2/decorated_sessions/", {
        query: { state_filter: RUNNING_CLUSTER_STATES, ...query },
      }),
    );
    return all.filter((c) => !c.is_system_cluster);
  }

  private workspaces(): Promise<AsWorkspace[]> {
    return listPages(40, 50, (query) =>
      this.api.get("/api/v2/experimental_workspaces/", { query }),
    );
  }

  /** Batch jobs only (services are listed from their own route), newest first. */
  private jobs(): Promise<AsJob[]> {
    return listPages(10, 100, (query) =>
      this.api.get("/api/v2/decorated_ha_jobs/", {
        query: { type_filter: "BATCH_JOB", ...query },
      }),
    );
  }

  private services(): Promise<AsService[]> {
    return listPages(20, 50, (query) => this.api.get("/api/v2/services-v2/", { query }));
  }

  /** Latest version of every named, unarchived compute config. */
  private computeConfigs(): Promise<AsComputeConfig[]> {
    return listPages(20, 100, (query) =>
      this.api.post("/api/v2/compute_templates/search", {
        query,
        body: { include_anonymous: false, archive_status: "NOT_ARCHIVED" },
      }),
    );
  }

  private budgets(): Promise<AsBudget[]> {
    return listPages(20, 50, (query) => this.api.get("/api/v2/instance_usage_budgets/", { query }));
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

  listResources(typeId: string, accountId: string): PluginEffect<ResourceInstance[]> {
    return attempt(async () => {
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
              this.clouds().catch((): AsCloud[] => []),
            ]);
            const names = new Map(clouds.map((c) => [c.id ?? "", c.name ?? ""]));
            return projects.map((p) => mapProject(accountId, p, names));
          });
        case "workspace":
          return this.scoped(async () => {
            const [workspaces, running, projects] = await Promise.all([
              this.workspaces(),
              this.runningClusters().catch((): AsCluster[] => []),
              this.projects().catch((): AsProject[] => []),
            ]);
            const clusters = new Map(running.map((c) => [c.id ?? "", c]));
            const projectNames = new Map(projects.map((p) => [p.id ?? "", p.name ?? ""]));
            return workspaces
              .filter((w) => !w.is_deleted)
              .map((w) =>
                mapWorkspace(accountId, w, clusters.get(w.cluster_id ?? ""), projectNames),
              );
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
          return this.scoped(async () =>
            (await this.budgets()).map((b) => mapBudget(accountId, b)),
          );
        default:
          throw new Error(`Anyscale plugin: unknown resource type "${typeId}"`);
      }
    });
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
      fetchTotalUsage(this.api, monthStart(now), isoDay(now)).catch(() => undefined),
      withBilling ? fetchCredits(this.api).catch(() => undefined) : Promise.resolve(undefined),
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

  getResource(
    typeId: string,
    resourceId: string,
    accountId: string,
  ): PluginEffect<ResourceInstance> {
    return attempt(async () => {
      const id = externalIdOf(resourceId);
      const enc = pathEncode(id);
      switch (typeId) {
        case "organization": {
          const [org] = await this.listOrganization(accountId, true);
          if (org) return org;
          break;
        }
        case "workspace": {
          const res = await this.api.get(`/api/v2/experimental_workspaces/${enc}`);
          const w = res.result;
          if (!w) break;
          const cluster = w.cluster_id
            ? await this.api
                .get(`/api/v2/decorated_sessions/${pathEncode(w.cluster_id)}`)
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
          const res = await this.api.get(`/api/v2/decorated_ha_jobs/${enc}`);
          if (res.result) return mapJob(accountId, res.result);
          break;
        }
        case "service": {
          const res = await this.api.get(`/api/v2/services-v2/${enc}`);
          if (res.result) return mapService(accountId, res.result);
          break;
        }
        case "budget": {
          const res = await this.api.get(`/api/v2/instance_usage_budgets/${enc}`);
          if (res.result) return mapBudget(accountId, res.result);
          break;
        }
        case "compute-config": {
          const res = await this.api.get(`/api/v2/compute_templates/${enc}`);
          if (res.result) return mapComputeConfig(accountId, res.result);
          break;
        }
        default:
          break;
      }
      const all = await runPluginEffect(this.listResources(typeId, accountId));
      const found = all.find((r) => r.id === resourceId || r.externalId === id);
      if (!found) throw new Error(`Anyscale plugin: resource ${typeId}/${resourceId} not found`);
      return found;
    });
  }

  resolveOutput(
    typeId: string,
    resourceId: string,
    outputKey: string,
    accountId: string,
  ): PluginEffect<string> {
    return attempt(async () => {
      const resource = await runPluginEffect(this.getResource(typeId, resourceId, accountId));
      const resolved = resource.resolvedOutputs[outputKey];
      if (resolved !== undefined) return resolved;
      const field = resource.fields[outputKey];
      if (field !== undefined) return String(field);
      throw new Error(`Anyscale plugin: cannot resolve output "${outputKey}" for type "${typeId}"`);
    });
  }

  /**
   * Detail-view extras, fetched only when someone opens the page: the
   * organization's spend breakdown and credit grants, and each workload's
   * spend over the last 30 days. All owner-only; absent for anyone else.
   */
  enrichDetail(resource: ResourceInstance): PluginEffect<ResourceInstance> {
    return attempt(async () => {
      const now = new Date();
      const today = isoDay(now);
      if (resource.resourceTypeId === "organization") {
        const from = monthStart(now);
        const [byType, byProject, byUser, credits] = await Promise.all([
          fetchUsageBreakdown(this.api, "cluster_type", from, today).catch(() => undefined),
          fetchUsageBreakdown(this.api, "project", from, today).catch(() => undefined),
          fetchUsageBreakdown(this.api, "user", from, today).catch(() => undefined),
          fetchCredits(this.api).catch(() => undefined),
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
        const rows = await fetchWorkloadSpend(this.api, resource.displayName, from, today).catch(
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
    });
  }

  // -------------------------------------------------------------------------
  // Stats, metrics, costs, credits
  // -------------------------------------------------------------------------

  fetchDashboardStats(
    resourceTypeId: string,
    resourceId: string,
    accountId: string,
  ): PluginEffect<DashboardStat[]> {
    return attempt(async () => {
      const r = await runPluginEffect(this.getResource(resourceTypeId, resourceId, accountId));
      const f = r.fields;
      const usd = (v: string | number | boolean | undefined) =>
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
            this.api,
            cloudId,
            rangeOrDefault(undefined, DEFAULT_METRICS_WINDOW_MS),
          ).catch((): MetricSeries[] => []);
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
    });
  }

  fetchMetricSeries(
    resourceTypeId: string,
    resourceId: string,
    accountId: string,
    timeRange?: { startMs: number; endMs: number },
  ): PluginEffect<MetricSeries[]> {
    return attempt(async () => {
      const id = externalIdOf(resourceId);
      switch (resourceTypeId) {
        case "organization":
          return dailySpendSeries(this.api, rangeOrDefault(timeRange, SPEND_METRICS_WINDOW_MS));
        case "cloud":
          return utilizationSeries(
            this.api,
            id,
            rangeOrDefault(timeRange, DEFAULT_METRICS_WINDOW_MS),
          );
        case "project": {
          const p = await runPluginEffect(this.getResource("project", resourceId, accountId));
          return utilizationSeries(
            this.api,
            String(p.fields["cloudId"] ?? ""),
            rangeOrDefault(timeRange, DEFAULT_METRICS_WINDOW_MS),
            id,
          );
        }
        default:
          return [];
      }
    });
  }

  fetchCostData(_accountId: string, range: CostFetchRange): PluginEffect<CostRow[]> {
    return attempt(async () => {
      return fetchAnyscaleCostData(this.api, range);
    });
  }

  fetchCreditBalance(_accountId: string): PluginEffect<CreditBalance[]> {
    return attempt(async () => {
      return creditBalances(await fetchCredits(this.api));
    });
  }

  // -------------------------------------------------------------------------
  // Create / update / delete
  // -------------------------------------------------------------------------

  getCreateConfig(typeId: string): PluginEffect<CreateResourceConfig> {
    return attempt(async () => {
      if (typeId === "project") {
        const clouds = await this.clouds().catch((): AsCloud[] => []);
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
                  id: c.id,
                  label: c.name ?? c.id,
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
          this.clouds().catch((): AsCloud[] => []),
          this.projects().catch((): AsProject[] => []),
        ]);
        const cloudName = new Map(clouds.map((c) => [c.id ?? "", c.name ?? c.id ?? ""]));
        return {
          fields: [
            {
              key: "name",
              label: "Name",
              kind: "text",
              required: true,
              placeholder: "Monthly cap",
            },
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
                ...projects.flatMap((p) => {
                  const cloudId = p.parent_cloud_id ?? p.cloud_id;
                  if (!p.id || !cloudId) return [];
                  return [
                    {
                      id: `project:${cloudId}:${p.id}`,
                      label: `Project: ${p.name ?? p.id}`,
                      description: cloudName.get(cloudId) ?? cloudId,
                    },
                  ];
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
    });
  }

  createResource(
    typeId: string,
    accountId: string,
    fields: Record<string, string>,
  ): PluginEffect<ResourceInstance> {
    return attempt(async () => {
      if (typeId === "project") {
        const cloudId = (fields["cloudId"] ?? "").trim();
        const res = await this.api.post("/api/v2/projects/", {
          body: {
            name: (fields["name"] ?? "").trim(),
            description: fields["description"] ?? "",
            ...(cloudId ? { cloud_id: cloudId, parent_cloud_id: cloudId } : {}),
          },
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
        const res = await this.api.post("/api/v2/instance_usage_budgets/", {
          body: {
            name: (fields["name"] ?? "").trim(),
            budget_amount: Number(fields["budgetAmount"] ?? 0),
            budget_unit: fields["budgetUnit"] || "DOLLARS",
            evaluation_period: fields["evaluationPeriod"] || "MONTHLY",
            ...scope,
          },
        });
        if (!res.result) throw new Error("Anyscale plugin: budget create returned nothing");
        return mapBudget(accountId, res.result);
      }
      throw new Error(`Anyscale plugin: cannot create "${typeId}" from Infrawrench`);
    });
  }

  updateResource(
    typeId: string,
    resourceId: string,
    accountId: string,
    fields: Record<string, string>,
  ): PluginEffect<ResourceInstance> {
    return attempt(async () => {
      if (typeId !== "budget") {
        throw new Error(`Anyscale plugin: "${typeId}" cannot be edited from Infrawrench`);
      }
      const budgetAmount = fields["budgetAmount"];
      const evaluationPeriod = fields["evaluationPeriod"];
      const budgetUnit = fields["budgetUnit"];
      const res = await this.api.put(
        `/api/v2/instance_usage_budgets/${pathEncode(externalIdOf(resourceId))}`,
        {
          query: {
            ...(budgetAmount ? { budget_amount: budgetAmount } : {}),
            ...(evaluationPeriod ? { evaluation_period: evaluationPeriod } : {}),
            ...(budgetUnit ? { budget_unit: budgetUnit } : {}),
          },
        },
      );
      if (res.result) return mapBudget(accountId, res.result);
      return runPluginEffect(this.getResource(typeId, resourceId, accountId));
    });
  }

  deleteResource(typeId: string, resourceId: string, _accountId: string): PluginEffect<void> {
    return attempt(async () => {
      const id = pathEncode(externalIdOf(resourceId));
      switch (typeId) {
        case "project":
          await this.api.delete(`/api/v2/projects/${id}`);
          return;
        case "compute-config":
          // Archiving is Anyscale's delete: every version is hidden and can no
          // longer launch new clusters; clusters already using it keep running.
          await this.api.post(`/api/v2/compute_templates/${id}/archive`);
          return;
        case "budget":
          await this.api.delete(`/api/v2/instance_usage_budgets/${id}`);
          return;
        default:
          throw new Error(`Anyscale plugin: "${typeId}" cannot be deleted from Infrawrench`);
      }
    });
  }

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  invokeAction(
    typeId: string,
    resourceId: string,
    actionId: string,
    accountId: string,
  ): PluginEffect<void> {
    return attempt(async () => {
      const id = externalIdOf(resourceId);
      const enc = pathEncode(id);
      if (typeId === "workspace" && (actionId === "start" || actionId === "terminate")) {
        const w = await runPluginEffect(this.getResource("workspace", resourceId, accountId));
        const clusterId = String(w.fields["clusterId"] ?? "");
        if (!clusterId) throw new Error("This workspace has no cluster to start or terminate.");
        const session = pathEncode(clusterId);
        // The same options `anyscale workspace_v2 start|terminate` send.
        if (actionId === "start") {
          await this.api.post(`/api/v2/sessions/${session}/start`, { body: {} });
        } else {
          await this.api.post(`/api/v2/sessions/${session}/stop`, {
            body: {
              terminate: true,
              workers_only: false,
              keep_min_workers: false,
              take_snapshot: false,
            },
          });
        }
        return;
      }
      if (typeId === "job" && actionId === "terminate") {
        await this.api.post(`/api/v2/decorated_ha_jobs/${enc}/terminate`);
        return;
      }
      if (typeId === "service" && actionId === "terminate") {
        await this.api.post(`/api/v2/services-v2/${enc}/terminate`);
        return;
      }
      if (typeId === "service" && actionId === "rollback") {
        await this.api.post(`/api/v2/services-v2/${enc}/rollback`, { body: {} });
        return;
      }
      if (typeId === "budget" && (actionId === "enable" || actionId === "disable")) {
        await this.api.post(`/api/v2/instance_usage_budgets/${enc}/toggle_is_enabled`, {
          query: { is_enabled: actionId === "enable" },
        });
        return;
      }
      throw new Error(`Anyscale plugin: unknown action "${actionId}" for "${typeId}"`);
    });
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
