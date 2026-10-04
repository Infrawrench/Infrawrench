import type {
  CostFetchRange,
  CostRow,
  CreateResourceConfig,
  DashboardStat,
  DetailViewSchema,
  HostServices,
  MetricSeries,
  PluginClient,
  PreflightResult,
  ResourceInstance,
  SecretHostServices,
  SidebarItemSchema,
} from "@infrawrench/plugin-base";
import { externalIdOf } from "@infrawrench/plugin-base";
import { invalidateStacks, listStacks, orgSlugOf, policyRegions, resolveOrg } from "./account.js";
import type { GrafanaContext } from "./api.js";
import { cloudFetch, requestId, smFetch, stackFetch, statusOf } from "./api.js";
import { fetchBillSummary, fetchGrafanaCostData } from "./cost-data.js";
import {
  mapAccessPolicy,
  mapAlertRule,
  mapContactPoint,
  mapDashboard,
  mapDatasource,
  mapMember,
  mapOrganization,
  mapStack,
  mapStackPlugin,
  mapSyntheticCheck,
  mapToken,
  parseLabels,
  resourceIdFor,
} from "./mappers.js";
import {
  BILL_METRICS_WINDOW_MS,
  STACK_METRICS_WINDOW_MS,
  billSeries,
  rangeOrDefault,
  resolveUsageSource,
  stackUsageSeries,
} from "./metrics.js";
import { verifyGrafanaCredentials } from "./preflight.js";
import { BILL_SUMMARY_KEY, renderGrafanaDetail, renderGrafanaSidebar } from "./render.js";
import type {
  GcAccessPolicy,
  GcCursorPage,
  GcMember,
  GcRegion,
  GcStack,
  GcStackPlugin,
  GcToken,
  GfAlertRule,
  GfContactPoint,
  GfDashboardHit,
  GfDatasource,
  GfFolder,
  SmCheck,
  SmProbe,
} from "./types.js";

/** Secret keys stored against a stack resource. */
export const SA_TOKEN_KEY = "serviceAccountToken";
export const SM_TOKEN_KEY = "syntheticMonitoringToken";

const SERVICE_ACCOUNT_NAME = "infrawrench";
const MAX_CURSOR_PAGES = 20;
const DASHBOARD_PAGE = 5000;

/** `a/b/c` → `["a", "b/c"]`: the first segment is the stack slug or the region. */
function splitScoped(externalId: string): [string, string] {
  const i = externalId.indexOf("/");
  return i < 0 ? ["", externalId] : [externalId.slice(0, i), externalId.slice(i + 1)];
}

/** The cursor to send next, from `metadata.pagination.nextPage` (a path or a bare cursor). */
export function nextCursor(nextPage: string | null | undefined): string | undefined {
  if (!nextPage) return undefined;
  const match = /[?&]pageCursor=([^&]+)/.exec(nextPage);
  if (match?.[1]) return decodeURIComponent(match[1]);
  return nextPage.includes("/") ? undefined : nextPage;
}

interface StackAccess {
  stack: GcStack;
  slug: string;
  url: string;
  saToken: string | null;
  smToken: string | null;
}

export class GrafanaCloudClient implements PluginClient {
  private readonly ctx: GrafanaContext;
  private readonly orgSlug: string;
  private readonly secrets: SecretHostServices | undefined;

  constructor(credentials: Record<string, string>, services?: HostServices) {
    const token = (credentials["token"] ?? "").trim();
    if (!token) throw new Error("Grafana Cloud plugin: missing token credential");
    const caCert = credentials["caCert"] ?? "";
    this.ctx = {
      token,
      ...(caCert ? { caCert } : {}),
      ...(services?.http ? { http: services.http } : {}),
    };
    this.orgSlug = (credentials["orgSlug"] ?? "").trim();
    this.secrets = services?.secrets;
  }

  // -------------------------------------------------------------------------
  // Shared lookups
  // -------------------------------------------------------------------------

  private slug(): Promise<string> {
    return orgSlugOf(this.ctx, this.orgSlug);
  }

  private stacks(): Promise<GcStack[]> {
    return listStacks(this.ctx, this.orgSlug);
  }

  private async secret(accountId: string, stackSlug: string, key: string): Promise<string | null> {
    if (!this.secrets) return null;
    const value = await this.secrets
      .getPlaintext(resourceIdFor(accountId, "stack", stackSlug), key)
      .catch(() => null);
    return value && value.trim() ? value.trim() : null;
  }

  private async storeSecret(accountId: string, stackSlug: string, key: string, value: string) {
    if (!this.secrets?.setPlaintext) {
      throw new Error(
        "This Infrawrench host cannot store stack tokens. Update the app and try again.",
      );
    }
    await this.secrets.setPlaintext(resourceIdFor(accountId, "stack", stackSlug), key, value);
  }

  private async stackAccess(accountId: string): Promise<StackAccess[]> {
    const stacks = await this.stacks();
    return Promise.all(
      stacks
        .filter((s) => s.slug)
        .map(async (s) => ({
          stack: s,
          slug: s.slug ?? "",
          url: s.url ?? `https://${s.slug}.grafana.net`,
          saToken: await this.secret(accountId, s.slug ?? "", SA_TOKEN_KEY),
          smToken: await this.secret(accountId, s.slug ?? "", SM_TOKEN_KEY),
        })),
    );
  }

  private async oneStack(accountId: string, stackSlug: string): Promise<StackAccess> {
    const found = (await this.stackAccess(accountId)).find((s) => s.slug === stackSlug);
    if (!found) throw new Error(`Grafana Cloud plugin: stack "${stackSlug}" not found`);
    return found;
  }

  private requireSa(access: StackAccess): string {
    if (!access.saToken) {
      throw new Error(
        `Stack ${access.slug} is not connected. Open the stack and use Connect stack, or edit it and paste a service account token.`,
      );
    }
    return access.saToken;
  }

  private requireSm(access: StackAccess): { apiUrl: string; token: string } {
    const apiUrl = access.stack.regionSyntheticMonitoringApiUrl;
    if (!access.smToken || !apiUrl) {
      throw new Error(
        `Stack ${access.slug} has no Synthetic Monitoring access token. Edit the stack and paste one.`,
      );
    }
    return { apiUrl, token: access.smToken };
  }

  /** A 403 on one list means the token lacks that one scope; that type lists empty. */
  private async scoped(load: () => Promise<ResourceInstance[]>): Promise<ResourceInstance[]> {
    try {
      return await load();
    } catch (err) {
      if (statusOf(err) === 403) return [];
      throw err;
    }
  }

  /**
   * Fan a stack-scoped lister out over the connected stacks. A stack whose
   * stored token is refused (rotated, deleted, too narrow) lists empty rather
   * than failing the other stacks.
   */
  private async perStack(
    accountId: string,
    needs: "sa" | "sm",
    load: (access: StackAccess) => Promise<ResourceInstance[]>,
  ): Promise<ResourceInstance[]> {
    const access = await this.stackAccess(accountId);
    const eligible = access.filter((a) =>
      needs === "sa" ? a.saToken : a.smToken && a.stack.regionSyntheticMonitoringApiUrl,
    );
    const results = await Promise.all(
      eligible.map(async (a) => {
        try {
          return await load(a);
        } catch (err) {
          const status = statusOf(err);
          if (status === 401 || status === 403 || status === 404) return [];
          throw err;
        }
      }),
    );
    return results.flat();
  }

  private async cursorList<T>(path: string, region: string): Promise<T[]> {
    const out: T[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_CURSOR_PAGES; page++) {
      const res = await cloudFetch<GcCursorPage<T>>(this.ctx, path, {
        query: { region, pageSize: 500, ...(cursor ? { pageCursor: cursor } : {}) },
      });
      out.push(...(res.items ?? []));
      cursor = nextCursor(res.metadata?.pagination?.nextPage);
      if (!cursor) break;
    }
    return out;
  }

  private async policiesByRegion(): Promise<Array<{ region: string; policy: GcAccessPolicy }>> {
    const seen = new Set<string>();
    const out: Array<{ region: string; policy: GcAccessPolicy }> = [];
    for (const region of await policyRegions(this.ctx, this.orgSlug)) {
      const items = await this.cursorList<GcAccessPolicy>("/v1/accesspolicies", region).catch(
        (err) => {
          // A region the org has nothing in can answer 404.
          if (statusOf(err) === 404 || statusOf(err) === 400) return [] as GcAccessPolicy[];
          throw err;
        },
      );
      for (const p of items) {
        if (!p.id || seen.has(p.id)) continue;
        seen.add(p.id);
        out.push({ region, policy: p });
      }
    }
    return out;
  }

  private async tokensByRegion(): Promise<Array<{ region: string; token: GcToken }>> {
    const seen = new Set<string>();
    const out: Array<{ region: string; token: GcToken }> = [];
    for (const region of await policyRegions(this.ctx, this.orgSlug)) {
      const items = await this.cursorList<GcToken>("/v1/tokens", region).catch((err) => {
        if (statusOf(err) === 404 || statusOf(err) === 400) return [] as GcToken[];
        throw err;
      });
      for (const t of items) {
        if (!t.id || seen.has(t.id)) continue;
        seen.add(t.id);
        out.push({ region, token: t });
      }
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // Listing
  // -------------------------------------------------------------------------

  async listResources(typeId: string, accountId: string): Promise<ResourceInstance[]> {
    switch (typeId) {
      case "organization":
        return [await this.organization(accountId, false)];
      case "stack": {
        const access = await this.stackAccess(accountId);
        return access.map((a) => mapStack(accountId, a.stack, { connected: Boolean(a.saToken) }));
      }
      case "stack-plugin":
        return this.scoped(async () => {
          const stacks = (await this.stacks()).filter((s) => s.id !== undefined && s.slug);
          const lists = await Promise.all(
            stacks.map(async (s) => {
              const res = await cloudFetch<{ items?: GcStackPlugin[] }>(
                this.ctx,
                `/instances/${s.id}/plugins`,
              );
              return (res.items ?? []).map((p) => mapStackPlugin(accountId, s.slug ?? "", p));
            }),
          );
          return lists.flat();
        });
      case "access-policy":
        return this.scoped(async () => {
          const names = new Map<string, string>();
          for (const s of await this.stacks().catch(() => [] as GcStack[])) {
            if (s.id !== undefined) names.set(String(s.id), s.slug ?? String(s.id));
          }
          return (await this.policiesByRegion()).map(({ region, policy }) =>
            mapAccessPolicy(accountId, region, policy, names),
          );
        });
      case "access-policy-token":
        return this.scoped(async () => {
          const policyNames = new Map<string, string>();
          for (const { policy } of await this.policiesByRegion().catch(() => [])) {
            if (policy.id)
              policyNames.set(policy.id, policy.displayName || policy.name || policy.id);
          }
          return (await this.tokensByRegion()).map(({ region, token }) =>
            mapToken(accountId, region, token, policyNames),
          );
        });
      case "member":
        return this.scoped(async () => {
          const slug = await this.slug();
          const res = await cloudFetch<{ items?: GcMember[] }>(
            this.ctx,
            `/orgs/${encodeURIComponent(slug)}/members`,
          );
          return (res.items ?? []).map((m) => mapMember(accountId, m));
        });
      case "dashboard":
        return this.perStack(accountId, "sa", async (a) => {
          const hits = await stackFetch<GfDashboardHit[]>(
            this.ctx,
            a.url,
            this.requireSa(a),
            "/api/search",
            { query: { type: "dash-db", limit: DASHBOARD_PAGE } },
          );
          return (hits ?? []).map((d) => mapDashboard(accountId, a, d));
        });
      case "alert-rule":
        return this.perStack(accountId, "sa", async (a) => {
          const token = this.requireSa(a);
          const [rules, folders] = await Promise.all([
            stackFetch<GfAlertRule[]>(this.ctx, a.url, token, "/api/v1/provisioning/alert-rules"),
            stackFetch<GfFolder[]>(this.ctx, a.url, token, "/api/folders", {
              query: { limit: 1000 },
            }).catch(() => [] as GfFolder[]),
          ]);
          const names = new Map<string, string>();
          for (const folder of folders ?? []) {
            if (folder.uid) names.set(folder.uid, folder.title ?? folder.uid);
          }
          return (rules ?? []).map((r) => mapAlertRule(accountId, a, r, names));
        });
      case "contact-point":
        return this.perStack(accountId, "sa", async (a) => {
          const points = await stackFetch<GfContactPoint[]>(
            this.ctx,
            a.url,
            this.requireSa(a),
            "/api/v1/provisioning/contact-points",
          );
          return (points ?? []).filter((c) => c.uid).map((c) => mapContactPoint(accountId, a, c));
        });
      case "datasource":
        return this.perStack(accountId, "sa", async (a) => {
          const sources = await stackFetch<GfDatasource[]>(
            this.ctx,
            a.url,
            this.requireSa(a),
            "/api/datasources",
          );
          return (sources ?? []).map((d) => mapDatasource(accountId, a, d));
        });
      case "synthetic-check":
        return this.perStack(accountId, "sm", async (a) => {
          const { apiUrl, token } = this.requireSm(a);
          const [checks, probes] = await Promise.all([
            this.smChecks(apiUrl, token),
            this.smProbes(apiUrl, token).catch(() => [] as SmProbe[]),
          ]);
          const names = new Map<number, string>();
          for (const p of probes) if (p.id !== undefined) names.set(p.id, p.name ?? String(p.id));
          return checks.map((c) => mapSyntheticCheck(accountId, a, c, names));
        });
      default:
        throw new Error(`Grafana Cloud plugin: unknown resource type "${typeId}"`);
    }
  }

  /** `/api/v1/check` in the current spec; older deployments only answer `/check/list`. */
  private async smChecks(apiUrl: string, token: string): Promise<SmCheck[]> {
    try {
      return (await smFetch<SmCheck[]>(this.ctx, apiUrl, token, "/api/v1/check")) ?? [];
    } catch (err) {
      if (statusOf(err) !== 404 && statusOf(err) !== 405) throw err;
      return (await smFetch<SmCheck[]>(this.ctx, apiUrl, token, "/api/v1/check/list")) ?? [];
    }
  }

  private async smProbes(apiUrl: string, token: string): Promise<SmProbe[]> {
    try {
      return (await smFetch<SmProbe[]>(this.ctx, apiUrl, token, "/api/v1/probe")) ?? [];
    } catch (err) {
      if (statusOf(err) !== 404 && statusOf(err) !== 405) throw err;
      return (await smFetch<SmProbe[]>(this.ctx, apiUrl, token, "/api/v1/probe/list")) ?? [];
    }
  }

  private async organization(accountId: string, withBill: boolean): Promise<ResourceInstance> {
    const [org, bill, stacks] = await Promise.all([
      resolveOrg(this.ctx, this.orgSlug),
      fetchBillSummary(this.ctx, this.orgSlug).catch(() => undefined),
      this.stacks().catch(() => undefined),
    ]);
    const r = mapOrganization(accountId, org, {
      ...(bill ? { monthToDate: bill.total } : {}),
      ...(stacks ? { stackCount: stacks.length } : {}),
    });
    if (withBill && bill) r.resolvedOutputs[BILL_SUMMARY_KEY] = JSON.stringify(bill);
    return r;
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
    if (typeId === "organization") return this.organization(accountId, true);
    if (typeId === "stack") {
      const s = await cloudFetch<GcStack>(this.ctx, `/instances/${encodeURIComponent(id)}`);
      const connected = Boolean(await this.secret(accountId, s.slug ?? id, SA_TOKEN_KEY));
      return mapStack(accountId, s, { connected });
    }
    const all = await this.listResources(typeId, accountId);
    const found = all.find((r) => r.id === resourceId || r.externalId === id);
    if (!found) throw new Error(`Grafana Cloud plugin: resource ${typeId}/${resourceId} not found`);
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
    throw new Error(`Grafana Cloud plugin: cannot resolve output "${outputKey}" for "${typeId}"`);
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
      typeof v === "number" ? `$${v.toLocaleString("en-US", { maximumFractionDigits: 2 })}` : "—";
    const n = (v: unknown) => (typeof v === "number" ? v.toLocaleString("en-US") : "—");
    switch (resourceTypeId) {
      case "organization":
        return [
          { label: "Billed This Month", value: usd(f["monthToDate"]) },
          { label: "Stacks", value: n(f["stackCount"]) },
        ];
      case "stack": {
        const status = String(f["status"] ?? "");
        return [
          {
            label: "Status",
            value: status || "—",
            variant:
              status === "active" ? "status-healthy" : status ? "status-degraded" : "default",
          },
          { label: "Active Series", value: n(f["activeSeries"]) },
          { label: "Region", value: String(f["region"] ?? "—") },
        ];
      }
      case "alert-rule":
        return [{ label: "State", value: f["paused"] === true ? "Paused" : "Evaluating" }];
      case "synthetic-check":
        return [
          { label: "Status", value: f["enabled"] === true ? "Enabled" : "Disabled" },
          { label: "Type", value: String(f["type"] ?? "—") },
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
    if (resourceTypeId === "organization") {
      return billSeries(
        this.ctx,
        await this.slug(),
        rangeOrDefault(timeRange, BILL_METRICS_WINDOW_MS),
      );
    }
    if (resourceTypeId !== "stack") return [];
    const stack = await this.getResource("stack", resourceId, accountId);
    const f = stack.fields;
    const slug = String(f["slug"] ?? externalIdOf(resourceId));
    const ids = {
      ...(f["promInstanceId"] ? { promInstanceId: String(f["promInstanceId"]) } : {}),
      ...(f["logsInstanceId"] ? { logsInstanceId: String(f["logsInstanceId"]) } : {}),
      ...(f["tracesInstanceId"] ? { tracesInstanceId: String(f["tracesInstanceId"]) } : {}),
    };
    const range = rangeOrDefault(timeRange, STACK_METRICS_WINDOW_MS);
    const source = await resolveUsageSource(this.ctx, {
      url: String(f["url"] ?? ""),
      saToken: await this.secret(accountId, slug, SA_TOKEN_KEY),
      ...(f["orgId"] ? { orgId: String(f["orgId"]) } : {}),
    });
    if (!source) return [];
    try {
      return await stackUsageSeries(this.ctx, source, ids, range);
    } catch (err) {
      // The data source proxy can be refused to a narrow token; the billing
      // endpoint may still answer with the access policy token.
      if (source.kind === "proxy" && f["orgId"]) {
        return stackUsageSeries(
          this.ctx,
          { kind: "billing", orgId: String(f["orgId"]) },
          ids,
          range,
        );
      }
      throw err;
    }
  }

  async fetchCostData(_accountId: string, range: CostFetchRange): Promise<CostRow[]> {
    return fetchGrafanaCostData(this.ctx, this.orgSlug, range);
  }

  async verifyCredentials(): Promise<PreflightResult> {
    return verifyGrafanaCredentials(this.ctx, this.orgSlug);
  }

  // -------------------------------------------------------------------------
  // Create / update / delete
  // -------------------------------------------------------------------------

  async getCreateConfig(typeId: string): Promise<CreateResourceConfig> {
    if (typeId !== "stack") {
      throw new Error(`Grafana Cloud plugin: cannot create "${typeId}" from Infrawrench`);
    }
    const res = await cloudFetch<{ items?: GcRegion[] }>(this.ctx, "/stack-regions").catch(() => ({
      items: [] as GcRegion[],
    }));
    const regions = (res.items ?? [])
      .filter((r) => r.slug && (!r.status || r.status === "active"))
      .filter((r) => !r.visibility || r.visibility === "public")
      .sort((a, b) => (a.publicName ?? a.slug ?? "").localeCompare(b.publicName ?? b.slug ?? ""));
    return {
      fields: [
        {
          key: "name",
          label: "Name",
          kind: "text",
          required: true,
          placeholder: "Production",
          description: "Display name of the stack.",
        },
        {
          key: "slug",
          label: "Slug",
          kind: "text",
          required: true,
          placeholder: "acme-prod",
          description:
            "Lowercase letters and numbers. The stack's Grafana is served at https://<slug>.grafana.net, and the slug cannot be changed later.",
        },
        {
          key: "region",
          label: "Region",
          kind: "select",
          required: true,
          description: "Where the stack's Grafana and its metrics, logs and traces backends run.",
          ...(regions[0]?.slug ? { defaultValue: regions[0].slug } : {}),
          options: regions.map((r) => ({
            id: r.slug ?? "",
            label: r.publicName ?? r.name ?? r.slug ?? "",
            ...(r.provider ? { description: `${r.provider.toUpperCase()} · ${r.slug ?? ""}` } : {}),
          })),
        },
        {
          key: "description",
          label: "Description",
          kind: "text",
          required: false,
        },
        {
          key: "labels",
          label: "Labels",
          kind: "text",
          required: false,
          placeholder: "team=platform, env=prod",
          description: "Comma-separated key=value pairs. Up to 10.",
        },
      ],
    };
  }

  async createResource(
    typeId: string,
    accountId: string,
    fields: Record<string, string>,
  ): Promise<ResourceInstance> {
    if (typeId !== "stack") {
      throw new Error(`Grafana Cloud plugin: cannot create "${typeId}" from Infrawrench`);
    }
    const slug = (fields["slug"] ?? "").trim().toLowerCase();
    if (!/^[a-z][a-z0-9]*(?:-?[a-z0-9]+)*$/.test(slug)) {
      throw new Error(
        "The slug must start with a letter and use only lowercase letters, numbers and hyphens.",
      );
    }
    const labels = parseLabels(fields["labels"] ?? "");
    const s = await cloudFetch<GcStack>(this.ctx, "/instances", {
      method: "POST",
      headers: requestId(),
      body: JSON.stringify({
        name: (fields["name"] ?? "").trim() || slug,
        slug,
        ...(fields["region"] ? { region: fields["region"] } : {}),
        ...(fields["description"]?.trim() ? { description: fields["description"].trim() } : {}),
        ...(Object.keys(labels).length > 0 ? { labels } : {}),
      }),
    });
    invalidateStacks(this.ctx);
    return mapStack(accountId, s);
  }

  async updateResource(
    typeId: string,
    resourceId: string,
    accountId: string,
    fields: Record<string, string>,
  ): Promise<ResourceInstance> {
    const id = externalIdOf(resourceId);
    switch (typeId) {
      case "stack": {
        if (fields[SA_TOKEN_KEY]?.trim()) {
          await this.storeSecret(accountId, id, SA_TOKEN_KEY, fields[SA_TOKEN_KEY].trim());
        }
        if (fields[SM_TOKEN_KEY]?.trim()) {
          await this.storeSecret(accountId, id, SM_TOKEN_KEY, fields[SM_TOKEN_KEY].trim());
        }
        const body: Record<string, unknown> = {};
        if ("name" in fields && fields["name"]?.trim()) body["name"] = fields["name"].trim();
        if ("description" in fields) body["description"] = fields["description"] ?? "";
        if ("labels" in fields) body["labels"] = parseLabels(fields["labels"] ?? "");
        if ("deleteProtection" in fields)
          body["deleteProtection"] = fields["deleteProtection"] === "true";
        if (Object.keys(body).length > 0) {
          await cloudFetch<GcStack>(this.ctx, `/instances/${encodeURIComponent(id)}`, {
            method: "POST",
            headers: requestId(),
            body: JSON.stringify(body),
          });
          invalidateStacks(this.ctx);
        }
        return this.getResource("stack", resourceId, accountId);
      }
      case "access-policy": {
        const [region, policyId] = splitScoped(id);
        const patch: Record<string, string> = {};
        if (fields["displayName"]?.trim()) patch["displayName"] = fields["displayName"].trim();
        if (fields["status"] === "active" || fields["status"] === "inactive") {
          patch["status"] = fields["status"];
        }
        await this.updatePolicy(region, policyId, patch);
        return this.getResource("access-policy", resourceId, accountId);
      }
      case "access-policy-token": {
        const [region, tokenId] = splitScoped(id);
        if (fields["displayName"]?.trim()) {
          await cloudFetch(this.ctx, `/v1/tokens/${encodeURIComponent(tokenId)}`, {
            method: "POST",
            headers: requestId(),
            query: { region },
            body: JSON.stringify({ displayName: fields["displayName"].trim() }),
          });
        }
        return this.getResource("access-policy-token", resourceId, accountId);
      }
      case "member": {
        const role = fields["role"] ?? "";
        if (role) {
          const slug = await this.slug();
          await cloudFetch(
            this.ctx,
            `/orgs/${encodeURIComponent(slug)}/members/${encodeURIComponent(id)}`,
            { method: "POST", headers: requestId(), body: JSON.stringify({ role }) },
          );
        }
        return this.getResource("member", resourceId, accountId);
      }
      default:
        throw new Error(`Grafana Cloud plugin: "${typeId}" cannot be edited from Infrawrench`);
    }
  }

  /**
   * Access policy updates send the whole policy: scopes and realms are read
   * back first so changing the name or the status never drops them.
   */
  private async updatePolicy(region: string, policyId: string, patch: Record<string, string>) {
    const path = `/v1/accesspolicies/${encodeURIComponent(policyId)}`;
    const current = await cloudFetch<GcAccessPolicy>(this.ctx, path, { query: { region } });
    await cloudFetch(this.ctx, path, {
      method: "POST",
      headers: requestId(),
      query: { region },
      body: JSON.stringify({
        displayName: current.displayName ?? current.name,
        scopes: current.scopes ?? [],
        realms: current.realms ?? [],
        ...(current.conditions ? { conditions: current.conditions } : {}),
        ...(current.status ? { status: current.status } : {}),
        ...patch,
      }),
    });
  }

  async deleteResource(typeId: string, resourceId: string, accountId: string): Promise<void> {
    const id = externalIdOf(resourceId);
    const [scope, rest] = splitScoped(id);
    switch (typeId) {
      case "stack":
        await cloudFetch(this.ctx, `/instances/${encodeURIComponent(id)}`, {
          method: "DELETE",
          headers: requestId(),
        });
        invalidateStacks(this.ctx);
        return;
      case "stack-plugin":
        await cloudFetch(
          this.ctx,
          `/instances/${encodeURIComponent(scope)}/plugins/${encodeURIComponent(rest)}`,
          { method: "DELETE", headers: requestId() },
        );
        return;
      case "access-policy":
        await cloudFetch(this.ctx, `/v1/accesspolicies/${encodeURIComponent(rest)}`, {
          method: "DELETE",
          headers: requestId(),
          query: { region: scope },
        });
        return;
      case "access-policy-token":
        await cloudFetch(this.ctx, `/v1/tokens/${encodeURIComponent(rest)}`, {
          method: "DELETE",
          headers: requestId(),
          query: { region: scope },
        });
        return;
      case "member": {
        const slug = await this.slug();
        await cloudFetch(
          this.ctx,
          `/orgs/${encodeURIComponent(slug)}/members/${encodeURIComponent(id)}`,
          { method: "DELETE", headers: requestId() },
        );
        return;
      }
      case "dashboard":
      case "alert-rule":
      case "contact-point":
      case "datasource": {
        const access = await this.oneStack(accountId, scope);
        const path = {
          dashboard: `/api/dashboards/uid/${encodeURIComponent(rest)}`,
          "alert-rule": `/api/v1/provisioning/alert-rules/${encodeURIComponent(rest)}`,
          "contact-point": `/api/v1/provisioning/contact-points/${encodeURIComponent(rest)}`,
          datasource: `/api/datasources/uid/${encodeURIComponent(rest)}`,
        }[typeId];
        await stackFetch(this.ctx, access.url, this.requireSa(access), path, { method: "DELETE" });
        return;
      }
      case "synthetic-check": {
        const access = await this.oneStack(accountId, scope);
        const { apiUrl, token } = this.requireSm(access);
        try {
          await smFetch(this.ctx, apiUrl, token, `/api/v1/check/${encodeURIComponent(rest)}`, {
            method: "DELETE",
          });
        } catch (err) {
          if (statusOf(err) !== 404 && statusOf(err) !== 405) throw err;
          await smFetch(
            this.ctx,
            apiUrl,
            token,
            `/api/v1/check/delete/${encodeURIComponent(rest)}`,
            {
              method: "DELETE",
            },
          );
        }
        return;
      }
      default:
        throw new Error(`Grafana Cloud plugin: "${typeId}" cannot be deleted from Infrawrench`);
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
    const [scope, rest] = splitScoped(id);
    if (typeId === "stack" && actionId === "restart") {
      await cloudFetch(this.ctx, `/instances/${encodeURIComponent(id)}/restart`, {
        method: "POST",
        headers: requestId(),
      });
      return;
    }
    if (typeId === "stack" && actionId === "connect") return this.connectStack(accountId, id);
    if (typeId === "stack-plugin" && actionId === "update") {
      const plugin = (await this.listResources("stack-plugin", accountId)).find(
        (r) => r.externalId === id,
      );
      const latest = String(plugin?.fields["latestVersion"] ?? "");
      await cloudFetch(
        this.ctx,
        `/instances/${encodeURIComponent(scope)}/plugins/${encodeURIComponent(rest)}`,
        {
          method: "POST",
          headers: requestId(),
          body: JSON.stringify(latest ? { version: latest } : {}),
        },
      );
      return;
    }
    if (typeId === "access-policy" && (actionId === "enable" || actionId === "disable")) {
      await this.updatePolicy(scope, rest, {
        status: actionId === "enable" ? "active" : "inactive",
      });
      return;
    }
    if (typeId === "alert-rule" && (actionId === "pause" || actionId === "resume")) {
      const access = await this.oneStack(accountId, scope);
      const token = this.requireSa(access);
      const path = `/api/v1/provisioning/alert-rules/${encodeURIComponent(rest)}`;
      const rule = await stackFetch<Record<string, unknown>>(this.ctx, access.url, token, path);
      await stackFetch(this.ctx, access.url, token, path, {
        method: "PUT",
        // Keeps the rule editable in Grafana's UI afterwards.
        headers: { "X-Disable-Provenance": "true" },
        body: JSON.stringify({ ...rule, isPaused: actionId === "pause" }),
      });
      return;
    }
    if (typeId === "datasource" && actionId === "test") {
      const access = await this.oneStack(accountId, scope);
      const res = await stackFetch<{ status?: string; message?: string }>(
        this.ctx,
        access.url,
        this.requireSa(access),
        `/api/datasources/uid/${encodeURIComponent(rest)}/health`,
      );
      if (res?.status && res.status.toUpperCase() !== "OK") {
        throw new Error(res.message || `Data source check failed (${res.status}).`);
      }
      return;
    }
    if (typeId === "synthetic-check" && (actionId === "enable" || actionId === "disable")) {
      const access = await this.oneStack(accountId, scope);
      const { apiUrl, token } = this.requireSm(access);
      const path = `/api/v1/check/${encodeURIComponent(rest)}`;
      const check = await smFetch<SmCheck>(this.ctx, apiUrl, token, path);
      const body = JSON.stringify({ ...check, enabled: actionId === "enable" });
      try {
        await smFetch(this.ctx, apiUrl, token, path, { method: "POST", body });
      } catch (err) {
        if (statusOf(err) !== 404 && statusOf(err) !== 405) throw err;
        await smFetch(this.ctx, apiUrl, token, "/api/v1/check/update", { method: "POST", body });
      }
      return;
    }
    throw new Error(`Grafana Cloud plugin: unknown action "${actionId}" for "${typeId}"`);
  }

  /**
   * Create (or reuse) an `infrawrench` service account on the stack through
   * the Cloud API's stack proxy, mint a token for it, and store the token
   * against the stack. Admin, because pausing alert rules and testing data
   * sources need it; a user who wants less pastes their own token instead.
   */
  private async connectStack(accountId: string, stackSlug: string): Promise<void> {
    const stack = (await this.stacks()).find((s) => s.slug === stackSlug);
    const instance = encodeURIComponent(String(stack?.id ?? stackSlug));
    const search = await cloudFetch<{
      serviceAccounts?: Array<{ id?: number; name?: string }>;
    }>(this.ctx, `/instances/${instance}/api/serviceaccounts/search`, {
      query: { query: SERVICE_ACCOUNT_NAME, perpage: 50 },
    }).catch((err) => {
      if (statusOf(err) === 403) {
        throw new Error(
          "The access policy token cannot create service accounts on this stack. Add the stack-service-accounts:write scope, or edit the stack and paste a service account token.",
        );
      }
      throw err;
    });
    let accountIdOnStack = search.serviceAccounts?.find((s) => s.name === SERVICE_ACCOUNT_NAME)?.id;
    if (accountIdOnStack === undefined) {
      const created = await cloudFetch<{ id?: number }>(
        this.ctx,
        `/instances/${instance}/api/serviceaccounts`,
        {
          method: "POST",
          headers: requestId(),
          body: JSON.stringify({ name: SERVICE_ACCOUNT_NAME, role: "Admin", isDisabled: false }),
        },
      );
      accountIdOnStack = created.id;
    }
    if (accountIdOnStack === undefined) {
      throw new Error("Grafana Cloud did not return the new service account.");
    }
    const minted = await cloudFetch<{ key?: string }>(
      this.ctx,
      `/instances/${instance}/api/serviceaccounts/${accountIdOnStack}/tokens`,
      {
        method: "POST",
        headers: requestId(),
        body: JSON.stringify({ name: `infrawrench-${new Date().toISOString().slice(0, 19)}` }),
      },
    );
    if (!minted.key) throw new Error("Grafana Cloud did not return the new token.");
    await this.storeSecret(accountId, stackSlug, SA_TOKEN_KEY, minted.key);
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  renderDetail(resource: ResourceInstance): DetailViewSchema {
    return renderGrafanaDetail(resource);
  }

  renderSidebarItem(resource: ResourceInstance): SidebarItemSchema {
    return renderGrafanaSidebar(resource);
  }
}
