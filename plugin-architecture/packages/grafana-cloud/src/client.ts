import type { Credentials } from "./plugin.js";
import { attempt, runPluginEffect } from "@infrawrench/plugin-base/effect";
import type { PluginEffect } from "@infrawrench/plugin-base";
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
import {
  ListPageError,
  ListTruncatedError,
  externalIdOf,
  pathEncode,
  requireListPage,
  rethrowIncompleteList,
  unencodedSegment,
} from "@infrawrench/plugin-base";
import type { ApiBody } from "@infrawrench/plugin-base";
import { invalidateStacks, listStacks, orgSlugOf, policyRegions, resolveOrg } from "./account.js";
import type { GrafanaContext } from "./api.js";
import { cloudApi, cloudItems, requestId, smApi, stackApi, statusOf } from "./api.js";
import type { operations as CloudOperations } from "./api-types.cloud.gen.js";
import type { operations as SmOperations } from "./api-types.sm.gen.js";
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
  GcRegion,
  GcStack,
  GcToken,
  GfAlertRule,
  GfDashboardHit,
  SmCheck,
  SmProbe,
} from "./types.js";

/** Secret keys stored against a stack resource. */
export const SA_TOKEN_KEY = "serviceAccountToken";
export const SM_TOKEN_KEY = "syntheticMonitoringToken";

const SERVICE_ACCOUNT_NAME = "infrawrench";
/** 50,000 rows at the 500 a page the Cloud API documents as its maximum. */
const MAX_CURSOR_PAGES = 100;
const CURSOR_PAGE_SIZE = 500;
const STACK_VENDOR = "Grafana stack";
const SM_VENDOR = "Grafana Synthetic Monitoring";
/** A folder past this shows its UID, as one the token may not read does. */
const MAX_FOLDER_LOOKUPS = 100;

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
  private readonly cloud: ReturnType<typeof cloudApi>;
  private readonly orgSlug: string;
  private readonly secrets: SecretHostServices | undefined;

  constructor(credentials: Credentials, services?: HostServices) {
    const token = (credentials["token"] ?? "").trim();
    if (!token) throw new Error("Grafana Cloud plugin: missing token credential");
    const caCert = credentials["caCert"] ?? "";
    this.ctx = {
      token,
      ...(caCert ? { caCert } : {}),
      ...(services?.http ? { http: services.http } : {}),
    };
    this.cloud = cloudApi(this.ctx);
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
    // Not caught: a stack that reads as not connected lists nothing, which prunes it.
    const value = await this.secrets.getPlaintext(
      resourceIdFor(accountId, "stack", stackSlug),
      key,
    );
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

  /**
   * A hand loop rather than `getAll`: it runs on past an empty page, a `nextPage`
   * it cannot read fails the list rather than ending it, and only the first
   * request can say the region has nothing, by a 404. A 400 says the request was
   * refused, which is no answer about the rows: read as empty it would prune them.
   */
  private async cursorList<T>(
    path: string,
    load: (cursor: string | undefined) => Promise<GcCursorPage<T>>,
  ): Promise<T[]> {
    const out: T[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_CURSOR_PAGES; page++) {
      const res = await load(cursor).catch((err): undefined => {
        if (page === 0 && statusOf(err) === 404) return undefined;
        throw err;
      });
      if (res === undefined) return out;
      out.push(...cloudItems(res, path));
      const nextPage = res.metadata?.pagination?.nextPage;
      if (!nextPage) return out;
      cursor = nextCursor(nextPage);
      if (!cursor) {
        const key = "metadata.pagination.nextPage";
        throw new ListPageError({ vendor: "Grafana Cloud", path, key, found: nextPage, page: res });
      }
    }
    throw new ListTruncatedError({
      vendor: "Grafana Cloud",
      path,
      items: out.length,
      maxPages: MAX_CURSOR_PAGES,
    });
  }

  private async policiesByRegion(): Promise<Array<{ region: string; policy: GcAccessPolicy }>> {
    const seen = new Set<string>();
    const out: Array<{ region: string; policy: GcAccessPolicy }> = [];
    for (const region of await policyRegions(this.ctx, this.orgSlug)) {
      const items = await this.cursorList("/v1/accesspolicies", (cursor) =>
        this.cloud.get("/v1/accesspolicies", {
          query: {
            region,
            pageSize: CURSOR_PAGE_SIZE,
            ...(cursor ? { pageCursor: cursor } : {}),
          },
        }),
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
      const items = await this.cursorList("/v1/tokens", (cursor) =>
        this.cloud.get("/v1/tokens", {
          query: {
            region,
            // The name implies they are left out otherwise. Asking is right either
            // way, and an expired token is one a user needs to find and delete.
            includeExpired: true,
            pageSize: CURSOR_PAGE_SIZE,
            ...(cursor ? { pageCursor: cursor } : {}),
          },
        }),
      );
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

  listResources(typeId: string, accountId: string): PluginEffect<ResourceInstance[]> {
    return attempt(async () => {
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
                const path = `/instances/${unencodedSegment(String(s.id))}/plugins` as const;
                const res = await this.cloud.get(path);
                return cloudItems(res, path).map((p) => mapStackPlugin(accountId, s.slug ?? "", p));
              }),
            );
            return lists.flat();
          });
        case "access-policy":
          return this.scoped(async () => {
            const names = new Map<string, string>();
            const stacks = await this.stacks().catch((err): GcStack[] => {
              rethrowIncompleteList(err);
              return [];
            });
            for (const s of stacks) {
              if (s.id !== undefined) names.set(String(s.id), s.slug ?? String(s.id));
            }
            return (await this.policiesByRegion()).map(({ region, policy }) =>
              mapAccessPolicy(accountId, region, policy, names),
            );
          });
        case "access-policy-token":
          return this.scoped(async () => {
            const policyNames = new Map<string, string>();
            const policies = await this.policiesByRegion().catch((err) => {
              rethrowIncompleteList(err);
              return [];
            });
            for (const { policy } of policies) {
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
            const path = `/orgs/${pathEncode(slug)}/members` as const;
            const res = await this.cloud.get(path);
            return cloudItems(res, path).map((m) => mapMember(accountId, m));
          });
        case "dashboard":
          return this.perStack(accountId, "sa", async (a) => {
            const hits = await stackApi(this.ctx, a.url, this.requireSa(a)).getAll(
              "/search",
              null,
              { query: { type: "dash-db" } },
            );
            return hits.map((d) => mapDashboard(accountId, a, d));
          });
        case "alert-rule":
          return this.perStack(accountId, "sa", async (a) => {
            const stack = stackApi(this.ctx, a.url, this.requireSa(a));
            const rules = requireListPage(await stack.get("/v1/provisioning/alert-rules"), {
              vendor: STACK_VENDOR,
              path: "/v1/provisioning/alert-rules",
              key: null,
            });
            const names = await this.folderNames(stack, rules);
            return rules.map((r) => mapAlertRule(accountId, a, r, names));
          });
        case "contact-point":
          return this.perStack(accountId, "sa", async (a) => {
            const points = await stackApi(this.ctx, a.url, this.requireSa(a)).get(
              "/v1/provisioning/contact-points",
            );
            return requireListPage(points, {
              vendor: STACK_VENDOR,
              path: "/v1/provisioning/contact-points",
              key: null,
            })
              .filter((c) => c.uid)
              .map((c) => mapContactPoint(accountId, a, c));
          });
        case "datasource":
          return this.perStack(accountId, "sa", async (a) => {
            const sources = await stackApi(this.ctx, a.url, this.requireSa(a)).get("/datasources");
            return requireListPage(sources, {
              vendor: STACK_VENDOR,
              path: "/datasources",
              key: null,
            }).map((d) => mapDatasource(accountId, a, d));
          });
        case "synthetic-check":
          return this.perStack(accountId, "sm", async (a) => {
            const { apiUrl, token } = this.requireSm(a);
            const [checks, probes] = await Promise.all([
              this.smChecks(apiUrl, token),
              this.smProbes(apiUrl, token).catch((err): SmProbe[] => {
                rethrowIncompleteList(err);
                return [];
              }),
            ]);
            const names = new Map<number, string>();
            for (const p of probes) if (p.id !== undefined) names.set(p.id, p.name ?? String(p.id));
            return checks.map((c) => mapSyntheticCheck(accountId, a, c, names));
          });
        default:
          throw new Error(`Grafana Cloud plugin: unknown resource type "${typeId}"`);
      }
    });
  }

  /**
   * The titles of the folders these rules are in. `/folders` with no `parentUid` is
   * only the root's children when nested folders are on, whereas a search by type
   * lists every level in one request. Grafana's reference does not promise that, so
   * a folder the search leaves out is read by its UID. These are only display names,
   * so part of them is fine: the rest show their UID.
   */
  private async folderNames(
    stack: ReturnType<typeof stackApi>,
    rules: GfAlertRule[],
  ): Promise<Map<string, string>> {
    const names = new Map<string, string>();
    if (rules.length === 0) return names;
    const folders = await stack
      .getAll("/search", null, { query: { type: "dash-folder" }, partial: true })
      .catch((err): GfDashboardHit[] | undefined => {
        rethrowIncompleteList(err);
        return undefined;
      });
    if (!folders) return names;
    for (const folder of folders) {
      if (folder.uid) names.set(folder.uid, folder.title ?? folder.uid);
    }
    const unnamed = new Set(rules.map((r) => r.folderUID).filter((uid) => uid && !names.has(uid)));
    await Promise.all(
      [...unnamed].slice(0, MAX_FOLDER_LOOKUPS).map(async (uid) => {
        const folder = await stack.get(`/folders/${pathEncode(uid)}`).catch(() => undefined);
        if (folder?.title) names.set(uid, folder.title);
      }),
    );
    return names;
  }

  /** `/api/v1/check` in the current spec; older deployments only answer `/check/list`. */
  private async smChecks(apiUrl: string, token: string): Promise<SmCheck[]> {
    const sm = smApi(this.ctx, apiUrl, token);
    const answer = await sm.get("/api/v1/check").catch((err) => {
      if (statusOf(err) !== 404 && statusOf(err) !== 405) throw err;
      return sm.get("/api/v1/check/list");
    });
    return requireListPage(answer, { vendor: SM_VENDOR, path: "/api/v1/check", key: null });
  }

  private async smProbes(apiUrl: string, token: string): Promise<SmProbe[]> {
    const sm = smApi(this.ctx, apiUrl, token);
    const answer = await sm.get("/api/v1/probe").catch((err) => {
      if (statusOf(err) !== 404 && statusOf(err) !== 405) throw err;
      return sm.get("/api/v1/probe/list");
    });
    return requireListPage(answer, { vendor: SM_VENDOR, path: "/api/v1/probe", key: null });
  }

  private async organization(accountId: string, withBill: boolean): Promise<ResourceInstance> {
    const [org, bill, stacks] = await Promise.all([
      resolveOrg(this.ctx, this.orgSlug),
      fetchBillSummary(this.ctx, this.orgSlug).catch((err) => {
        rethrowIncompleteList(err);
        return undefined;
      }),
      this.stacks().catch((err) => {
        rethrowIncompleteList(err);
        return undefined;
      }),
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

  getResource(
    typeId: string,
    resourceId: string,
    accountId: string,
  ): PluginEffect<ResourceInstance> {
    return attempt(async () => {
      const id = externalIdOf(resourceId);
      if (typeId === "organization") return this.organization(accountId, true);
      if (typeId === "stack") {
        const s = await this.cloud.get(`/instances/${pathEncode(id)}`);
        const connected = Boolean(await this.secret(accountId, s.slug ?? id, SA_TOKEN_KEY));
        return mapStack(accountId, s, { connected });
      }
      const all = await runPluginEffect(this.listResources(typeId, accountId));
      const found = all.find((r) => r.id === resourceId || r.externalId === id);
      if (!found)
        throw new Error(`Grafana Cloud plugin: resource ${typeId}/${resourceId} not found`);
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
      throw new Error(`Grafana Cloud plugin: cannot resolve output "${outputKey}" for "${typeId}"`);
    });
  }

  // -------------------------------------------------------------------------
  // Stats, metrics and costs
  // -------------------------------------------------------------------------

  fetchDashboardStats(
    resourceTypeId: string,
    resourceId: string,
    accountId: string,
  ): PluginEffect<DashboardStat[]> {
    return attempt(async () => {
      const r = await runPluginEffect(this.getResource(resourceTypeId, resourceId, accountId));
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
    });
  }

  fetchMetricSeries(
    resourceTypeId: string,
    resourceId: string,
    accountId: string,
    timeRange?: { startMs: number; endMs: number },
  ): PluginEffect<MetricSeries[]> {
    return attempt(async () => {
      if (resourceTypeId === "organization") {
        return billSeries(
          this.ctx,
          await this.slug(),
          rangeOrDefault(timeRange, BILL_METRICS_WINDOW_MS),
        );
      }
      if (resourceTypeId !== "stack") return [];
      const stack = await runPluginEffect(this.getResource("stack", resourceId, accountId));
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
    });
  }

  fetchCostData(_accountId: string, range: CostFetchRange): PluginEffect<CostRow[]> {
    return attempt(async () => {
      return fetchGrafanaCostData(this.ctx, this.orgSlug, range);
    });
  }

  verifyCredentials(): PluginEffect<PreflightResult> {
    return attempt(async () => {
      return verifyGrafanaCredentials(this.ctx, this.orgSlug);
    });
  }

  // -------------------------------------------------------------------------
  // Create / update / delete
  // -------------------------------------------------------------------------

  getCreateConfig(typeId: string): PluginEffect<CreateResourceConfig> {
    return attempt(async () => {
      if (typeId !== "stack") {
        throw new Error(`Grafana Cloud plugin: cannot create "${typeId}" from Infrawrench`);
      }
      const res = await this.cloud
        .get("/stack-regions")
        .catch((): { items?: GcRegion[] } => ({ items: [] }));
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
              ...(r.provider
                ? { description: `${r.provider.toUpperCase()} · ${r.slug ?? ""}` }
                : {}),
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
    });
  }

  createResource(
    typeId: string,
    accountId: string,
    fields: Record<string, string>,
  ): PluginEffect<ResourceInstance> {
    return attempt(async () => {
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
      const s = await this.cloud.post("/instances", {
        headers: requestId(),
        body: {
          name: (fields["name"] ?? "").trim() || slug,
          slug,
          ...(fields["region"] ? { region: fields["region"] } : {}),
          ...(fields["description"]?.trim() ? { description: fields["description"].trim() } : {}),
          ...(Object.keys(labels).length > 0 ? { labels } : {}),
        },
      });
      invalidateStacks(this.ctx);
      return mapStack(accountId, s);
    });
  }

  updateResource(
    typeId: string,
    resourceId: string,
    accountId: string,
    fields: Record<string, string>,
  ): PluginEffect<ResourceInstance> {
    return attempt(async () => {
      const id = externalIdOf(resourceId);
      switch (typeId) {
        case "stack": {
          if (fields[SA_TOKEN_KEY]?.trim()) {
            await this.storeSecret(accountId, id, SA_TOKEN_KEY, fields[SA_TOKEN_KEY].trim());
          }
          if (fields[SM_TOKEN_KEY]?.trim()) {
            await this.storeSecret(accountId, id, SM_TOKEN_KEY, fields[SM_TOKEN_KEY].trim());
          }
          const body: ApiBody<CloudOperations["postInstance"]> = {};
          if ("name" in fields && fields["name"]?.trim()) body.name = fields["name"].trim();
          if ("description" in fields) body.description = fields["description"] ?? "";
          if ("labels" in fields) body.labels = parseLabels(fields["labels"] ?? "");
          if ("deleteProtection" in fields)
            body.deleteProtection = fields["deleteProtection"] === "true";
          if (Object.keys(body).length > 0) {
            await this.cloud.post(`/instances/${pathEncode(id)}`, {
              headers: requestId(),
              body,
            });
            invalidateStacks(this.ctx);
          }
          return runPluginEffect(this.getResource("stack", resourceId, accountId));
        }
        case "access-policy": {
          const [region, policyId] = splitScoped(id);
          const patch: Record<string, string> = {};
          if (fields["displayName"]?.trim()) patch["displayName"] = fields["displayName"].trim();
          if (fields["status"] === "active" || fields["status"] === "inactive") {
            patch["status"] = fields["status"];
          }
          await this.updatePolicy(region, policyId, patch);
          return runPluginEffect(this.getResource("access-policy", resourceId, accountId));
        }
        case "access-policy-token": {
          const [region, tokenId] = splitScoped(id);
          if (fields["displayName"]?.trim()) {
            await this.cloud.post(`/v1/tokens/${pathEncode(tokenId)}`, {
              headers: requestId(),
              query: { region },
              body: { displayName: fields["displayName"].trim() },
            });
          }
          return runPluginEffect(this.getResource("access-policy-token", resourceId, accountId));
        }
        case "member": {
          const role = fields["role"] ?? "";
          if (role) {
            const slug = await this.slug();
            await this.cloud.post(`/orgs/${pathEncode(slug)}/members/${pathEncode(id)}`, {
              headers: requestId(),
              body: { role },
            });
          }
          return runPluginEffect(this.getResource("member", resourceId, accountId));
        }
        default:
          throw new Error(`Grafana Cloud plugin: "${typeId}" cannot be edited from Infrawrench`);
      }
    });
  }

  /**
   * Access policy updates send the whole policy: everything is read back first so
   * changing the name or the status never drops it. Nothing says what an update
   * with no `attributes` does, and they hold limits (the Loki query policy, the PDC
   * hosts), so they go back as read: the same values if Grafana would have kept them.
   * `allowedAudiences` and `allowedScopes` are on the read only, not the update body.
   */
  private async updatePolicy(region: string, policyId: string, patch: Record<string, string>) {
    if (!region || !policyId) {
      throw new Error(
        `Grafana Cloud plugin: access policy "${region}/${policyId}" has no region or id`,
      );
    }
    const id = pathEncode(policyId);
    const current = await this.cloud.get(`/v1/accesspolicies/${id}`, { query: { region } });
    const { lokiQueryPolicy, pdcConfiguration } = current.attributes ?? {};
    await this.cloud.post(`/v1/accesspolicies/${id}`, {
      headers: requestId(),
      query: { region },
      body: {
        displayName: current.displayName ?? current.name,
        scopes: current.scopes ?? [],
        realms: current.realms ?? [],
        ...(lokiQueryPolicy || pdcConfiguration
          ? {
              attributes: {
                ...(lokiQueryPolicy ? { lokiQueryPolicy } : {}),
                ...(pdcConfiguration ? { pdcConfiguration } : {}),
              },
            }
          : {}),
        ...(current.conditions ? { conditions: current.conditions } : {}),
        ...(current.status ? { status: current.status } : {}),
        ...patch,
      },
    });
  }

  deleteResource(typeId: string, resourceId: string, accountId: string): PluginEffect<void> {
    return attempt(async () => {
      const id = externalIdOf(resourceId);
      const [scope, rest] = splitScoped(id);
      switch (typeId) {
        case "stack":
          await this.cloud.delete(`/instances/${pathEncode(id)}`, { headers: requestId() });
          invalidateStacks(this.ctx);
          return;
        case "stack-plugin":
          await this.cloud.delete(`/instances/${pathEncode(scope)}/plugins/${pathEncode(rest)}`, {
            headers: requestId(),
          });
          return;
        case "access-policy":
          await this.cloud.delete(`/v1/accesspolicies/${pathEncode(rest)}`, {
            headers: requestId(),
            query: { region: scope },
          });
          return;
        case "access-policy-token":
          await this.cloud.delete(`/v1/tokens/${pathEncode(rest)}`, {
            headers: requestId(),
            query: { region: scope },
          });
          return;
        case "member": {
          const slug = await this.slug();
          await this.cloud.delete(`/orgs/${pathEncode(slug)}/members/${pathEncode(id)}`, {
            headers: requestId(),
          });
          return;
        }
        case "dashboard":
        case "alert-rule":
        case "contact-point":
        case "datasource": {
          const access = await this.oneStack(accountId, scope);
          const stack = stackApi(this.ctx, access.url, this.requireSa(access));
          const uid = pathEncode(rest);
          await {
            dashboard: () => stack.delete(`/dashboards/uid/${uid}`),
            "alert-rule": () => stack.delete(`/v1/provisioning/alert-rules/${uid}`),
            "contact-point": () => stack.delete(`/v1/provisioning/contact-points/${uid}`),
            datasource: () => stack.delete(`/datasources/uid/${uid}`),
          }[typeId]();
          return;
        }
        case "synthetic-check": {
          const access = await this.oneStack(accountId, scope);
          const { apiUrl, token } = this.requireSm(access);
          const sm = smApi(this.ctx, apiUrl, token);
          try {
            await sm.delete(`/api/v1/check/${pathEncode(rest)}`);
          } catch (err) {
            if (statusOf(err) !== 404 && statusOf(err) !== 405) throw err;
            await sm.delete(`/api/v1/check/delete/${pathEncode(rest)}`);
          }
          return;
        }
        default:
          throw new Error(`Grafana Cloud plugin: "${typeId}" cannot be deleted from Infrawrench`);
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
      const [scope, rest] = splitScoped(id);
      if (typeId === "stack" && actionId === "restart") {
        await this.cloud.post(`/instances/${pathEncode(id)}/restart`, { headers: requestId() });
        return;
      }
      if (typeId === "stack" && actionId === "connect") return this.connectStack(accountId, id);
      if (typeId === "stack-plugin" && actionId === "update") {
        const plugin = (await runPluginEffect(this.listResources("stack-plugin", accountId))).find(
          (r) => r.externalId === id,
        );
        const latest = String(plugin?.fields["latestVersion"] ?? "");
        await this.cloud.post(`/instances/${pathEncode(scope)}/plugins/${pathEncode(rest)}`, {
          headers: requestId(),
          body: latest ? { version: latest } : {},
        });
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
        const stack = stackApi(this.ctx, access.url, this.requireSa(access));
        const uid = pathEncode(rest);
        const rule = await stack.get(`/v1/provisioning/alert-rules/${uid}`);
        await stack.put(`/v1/provisioning/alert-rules/${uid}`, {
          // Keeps the rule editable in Grafana's UI afterwards.
          headers: { "X-Disable-Provenance": "true" },
          body: { ...rule, isPaused: actionId === "pause" },
        });
        return;
      }
      if (typeId === "datasource" && actionId === "test") {
        const access = await this.oneStack(accountId, scope);
        const res = await stackApi(this.ctx, access.url, this.requireSa(access)).get(
          `/datasources/uid/${pathEncode(rest)}/health`,
        );
        if (res?.status && res.status.toUpperCase() !== "OK") {
          throw new Error(res.message || `Data source check failed (${res.status}).`);
        }
        return;
      }
      if (typeId === "synthetic-check" && (actionId === "enable" || actionId === "disable")) {
        const access = await this.oneStack(accountId, scope);
        const { apiUrl, token } = this.requireSm(access);
        const sm = smApi(this.ctx, apiUrl, token);
        const checkId = pathEncode(rest);
        const check = await sm.get(`/api/v1/check/${checkId}`);
        const body: ApiBody<SmOperations["POST_/api/v1/check/:id"]> = {
          ...check,
          enabled: actionId === "enable",
        };
        try {
          await sm.post(`/api/v1/check/${checkId}`, { body });
        } catch (err) {
          if (statusOf(err) !== 404 && statusOf(err) !== 405) throw err;
          await sm.post("/api/v1/check/update", { body });
        }
        return;
      }
      throw new Error(`Grafana Cloud plugin: unknown action "${actionId}" for "${typeId}"`);
    });
  }

  /**
   * Create (or reuse) an `infrawrench` service account on the stack through
   * the Cloud API's stack proxy, mint a token for it, and store the token
   * against the stack. Admin, because pausing alert rules and testing data
   * sources need it; a user who wants less pastes their own token instead.
   */
  private async connectStack(accountId: string, stackSlug: string): Promise<void> {
    const stack = (await this.stacks()).find((s) => s.slug === stackSlug);
    const instance = pathEncode(String(stack?.id ?? stackSlug));
    const search = await this.cloud
      .get(`/instances/${instance}/api/serviceaccounts/search`, {
        query: { query: SERVICE_ACCOUNT_NAME, perpage: 50 },
      })
      .catch((err) => {
        if (statusOf(err) === 403) {
          throw new Error(
            "The access policy token cannot create service accounts on this stack. Add the stack-service-accounts:write scope, or edit the stack and paste a service account token.",
          );
        }
        throw err;
      });
    let accountIdOnStack = search.serviceAccounts?.find((s) => s.name === SERVICE_ACCOUNT_NAME)?.id;
    if (accountIdOnStack === undefined) {
      const created = await this.cloud.post(`/instances/${instance}/api/serviceaccounts`, {
        headers: requestId(),
        body: { name: SERVICE_ACCOUNT_NAME, role: "Admin", isDisabled: false },
      });
      accountIdOnStack = created.id;
    }
    if (accountIdOnStack === undefined) {
      throw new Error("Grafana Cloud did not return the new service account.");
    }
    const minted = await this.cloud.post(
      `/instances/${instance}/api/serviceaccounts/${unencodedSegment(String(accountIdOnStack))}/tokens`,
      {
        headers: requestId(),
        body: { name: `infrawrench-${new Date().toISOString().slice(0, 19)}` },
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
