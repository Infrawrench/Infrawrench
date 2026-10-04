import type {
  CostFetchRange,
  CostFetchResult,
  CostRow,
  CreateResourceConfig,
  DashboardStat,
  DetailViewSchema,
  HostServices,
  LogsFetchParams,
  LogsFetchResult,
  MetricSeries,
  PluginClient,
  ResourceInstance,
  SidebarItemSchema,
} from "@infrawrench/plugin-base";
import { decodePromptArgs, externalIdOf, withMetricsCapability } from "@infrawrench/plugin-base";
import type { RcTask, RedisCloudContext } from "./api.js";
import { rcFetch, readViaTask, statusOf, submitTask } from "./api.js";
import { fetchRedisCloudCostData } from "./cost-data.js";
import type { DatabaseContext, PlanKind } from "./mappers.js";
import {
  databaseDatasetGb,
  mapAccount,
  mapAclRole,
  mapAclRule,
  mapAclUser,
  mapCloudAccount,
  mapDatabase,
  mapEssentialsSubscription,
  mapProSubscription,
  mapPscEndpoint,
  mapTransitGateway,
  mapVpcPeering,
  parseSubscriptionExternalId,
  splitEndpoint,
  subscriptionExternalId,
} from "./mappers.js";
import { METRICS_WINDOW_MS, memorySeries, prometheusSeries, scrapePrometheus } from "./metrics.js";
import {
  ENRICH,
  alertDefinition,
  minDatasetGb,
  renderRedisCloudDetail,
  renderRedisCloudSidebar,
  roleFormFields,
} from "./render.js";
import { EVICTION_OPTIONS, PERSISTENCE_OPTIONS, RESOURCE_TYPES, T } from "./resource-types.js";
import type {
  RcAccount,
  RcAclRole,
  RcAclRule,
  RcAclUser,
  RcCloudAccount,
  RcDatabase,
  RcEssentialsPlan,
  RcEssentialsSubscription,
  RcEssentialsSubscriptionDatabases,
  RcPaymentMethod,
  RcPricing,
  RcProSubscription,
  RcProSubscriptionDatabases,
  RcPscEndpoint,
  RcPscService,
  RcSlowLogEntry,
  RcSystemLogEntry,
  RcTgwInvitation,
  RcTransitGateway,
  RcVpcPeering,
} from "./types.js";

const DB_PAGE = 100;
const MAX_DB_PAGES = 50;
/** List results are reused for this long within one client, so a sync does not re-list per type. */
const CACHE_MS = 20_000;

interface DbRef extends DatabaseContext {
  databaseId: string;
}

function asArray<T>(v: T[] | T | undefined): T[] {
  if (v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}

function csv(raw: string | undefined): string[] {
  return String(raw ?? "")
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function bool(raw: string | undefined): boolean | undefined {
  if (raw === undefined || raw === "") return undefined;
  return raw === "true" || raw === "1" || raw === "yes";
}

function finishedMessage(finished: boolean, what: string): { ok: true; message: string } {
  return {
    ok: true,
    message: finished
      ? `${what} complete.`
      : `${what} submitted; Redis Cloud is still processing it. Refresh in a few minutes.`,
  };
}

export class RedisCloudClient implements PluginClient {
  readonly ctx: RedisCloudContext;
  private readonly http: HostServices["http"];
  private cache = new Map<string, { at: number; value: Promise<unknown> }>();
  private dbIndex = new Map<string, DbRef>();

  constructor(credentials: Record<string, string>, services?: HostServices) {
    const accountKey = (credentials["accountKey"] ?? "").trim();
    const userKey = (credentials["userKey"] ?? "").trim();
    if (!accountKey) throw new Error("Redis Cloud plugin: missing accountKey credential");
    if (!userKey) throw new Error("Redis Cloud plugin: missing userKey credential");
    this.http = services?.http;
    this.ctx = { accountKey, userKey, ...(services?.http ? { http: services.http } : {}) };
  }

  private cached<T>(key: string, load: () => Promise<T>): Promise<T> {
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.value as Promise<T>;
    const value = load();
    this.cache.set(key, { at: Date.now(), value });
    value.catch(() => this.cache.delete(key));
    return value;
  }

  private invalidate(): void {
    this.cache.clear();
  }

  private get<T>(path: string, query?: Record<string, string | number | undefined>): Promise<T> {
    return rcFetch<T>(this.ctx, "GET", path, undefined, query);
  }

  // -------------------------------------------------------------------------
  // Inventory
  // -------------------------------------------------------------------------

  proSubscriptions(): Promise<RcProSubscription[]> {
    return this.cached("pro-subs", async () => {
      const res = await this.get<{ subscriptions?: RcProSubscription[] }>("/subscriptions");
      return res?.subscriptions ?? [];
    });
  }

  essentialsSubscriptions(): Promise<RcEssentialsSubscription[]> {
    return this.cached("ess-subs", async () => {
      const res = await this.get<{ subscriptions?: RcEssentialsSubscription[] }>(
        "/fixed/subscriptions",
      );
      return res?.subscriptions ?? [];
    });
  }

  proPricing(subscriptionId: number): Promise<RcPricing[]> {
    return this.cached(`pricing-${subscriptionId}`, async () => {
      const res = await this.get<{ pricing?: RcPricing[] }>(
        `/subscriptions/${subscriptionId}/pricing`,
      );
      return res?.pricing ?? [];
    });
  }

  private async proDatabases(subscriptionId: number): Promise<RcDatabase[]> {
    return this.cached(`pro-dbs-${subscriptionId}`, async () => {
      const out: RcDatabase[] = [];
      for (let page = 0; page < MAX_DB_PAGES; page++) {
        const res = await this.get<RcProSubscriptionDatabases>(
          `/subscriptions/${subscriptionId}/databases`,
          { offset: page * DB_PAGE, limit: DB_PAGE },
        );
        const batch = asArray(res?.subscription).flatMap((s) => s.databases ?? []);
        out.push(...batch);
        if (batch.length < DB_PAGE) break;
      }
      return out;
    });
  }

  private async essentialsDatabases(subscriptionId: number): Promise<RcDatabase[]> {
    return this.cached(`ess-dbs-${subscriptionId}`, async () => {
      const out: RcDatabase[] = [];
      for (let page = 0; page < MAX_DB_PAGES; page++) {
        const res = await this.get<RcEssentialsSubscriptionDatabases>(
          `/fixed/subscriptions/${subscriptionId}/databases`,
          { offset: page * DB_PAGE, limit: DB_PAGE },
        );
        const batch = asArray(res?.subscription).flatMap((s) => s.databases ?? []);
        out.push(...batch);
        if (batch.length < DB_PAGE) break;
      }
      return out;
    });
  }

  private async listDatabases(accountId: string): Promise<ResourceInstance[]> {
    const out: ResourceInstance[] = [];
    const [pro, ess] = await Promise.all([this.proSubscriptions(), this.essentialsSubscriptions()]);
    for (const sub of pro) {
      if (sub.id === undefined) continue;
      const ctx: DatabaseContext = {
        kind: "pro",
        subscriptionId: String(sub.id),
        ...(sub.name ? { subscriptionName: sub.name } : {}),
      };
      for (const db of await this.proDatabases(sub.id)) {
        if (db.databaseId === undefined) continue;
        this.dbIndex.set(String(db.databaseId), { ...ctx, databaseId: String(db.databaseId) });
        out.push(mapDatabase(accountId, db, ctx));
      }
    }
    for (const sub of ess) {
      if (sub.id === undefined) continue;
      const ctx: DatabaseContext = {
        kind: "essentials",
        subscriptionId: String(sub.id),
        ...(sub.name ? { subscriptionName: sub.name } : {}),
        free: sub.price === 0,
      };
      for (const db of await this.essentialsDatabases(sub.id)) {
        if (db.databaseId === undefined) continue;
        this.dbIndex.set(String(db.databaseId), { ...ctx, databaseId: String(db.databaseId) });
        out.push(mapDatabase(accountId, db, ctx));
      }
    }
    return out;
  }

  private async dbRef(databaseId: string, accountId: string): Promise<DbRef> {
    let ref = this.dbIndex.get(databaseId);
    if (!ref) {
      await this.listDatabases(accountId);
      ref = this.dbIndex.get(databaseId);
    }
    if (!ref) throw new Error(`Redis Cloud plugin: database ${databaseId} not found`);
    return ref;
  }

  private dbPath(ref: DbRef): string {
    return ref.kind === "pro"
      ? `/subscriptions/${ref.subscriptionId}/databases/${ref.databaseId}`
      : `/fixed/subscriptions/${ref.subscriptionId}/databases/${ref.databaseId}`;
  }

  /** The single-database GET: the only one that includes the default user's password. */
  private fetchDatabase(ref: DbRef): Promise<RcDatabase> {
    return this.cached(`db-${ref.databaseId}`, () => this.get<RcDatabase>(this.dbPath(ref)));
  }

  private providerOf(sub: RcProSubscription): string {
    return (sub.cloudDetails ?? []).map((c) => c.provider ?? "").join(",");
  }

  private async listPeerings(accountId: string): Promise<ResourceInstance[]> {
    const out: ResourceInstance[] = [];
    for (const sub of await this.proSubscriptions()) {
      if (sub.id === undefined || sub.status !== "active") continue;
      const provider = this.providerOf(sub);
      if (!/aws|gcp/i.test(provider)) continue;
      const aa = sub.deploymentType === "active-active";
      try {
        if (aa) {
          const res = await readViaTask<{
            regions?: Array<{
              region?: string;
              vpcPeerings?: Array<
                RcVpcPeering & {
                  id?: number;
                  vpcProjectUid?: string;
                  vpcNetworkName?: string;
                  sourceRegion?: string;
                }
              >;
            }>;
          }>(this.ctx, `/subscriptions/${sub.id}/regions/peerings`);
          for (const region of res?.regions ?? []) {
            for (const p of region.vpcPeerings ?? []) {
              out.push(
                mapVpcPeering(accountId, String(sub.id), provider, {
                  ...p,
                  vpcPeeringId: p.vpcPeeringId ?? p.id,
                  regionName: p.regionName ?? region.region,
                  projectUid: p.projectUid ?? p.vpcProjectUid,
                  networkName: p.networkName ?? p.vpcNetworkName,
                }),
              );
            }
          }
        } else {
          const res = await readViaTask<{ peerings?: RcVpcPeering[] }>(
            this.ctx,
            `/subscriptions/${sub.id}/peerings`,
          );
          for (const p of res?.peerings ?? []) {
            out.push(mapVpcPeering(accountId, String(sub.id), provider, p));
          }
        }
      } catch (err) {
        if (statusOf(err) === 401) throw err;
        // A subscription in a state the API will not describe lists empty.
      }
    }
    return out;
  }

  private async listTransitGateways(accountId: string): Promise<ResourceInstance[]> {
    const out: ResourceInstance[] = [];
    for (const sub of await this.proSubscriptions()) {
      if (sub.id === undefined || sub.status !== "active") continue;
      if (!/aws/i.test(this.providerOf(sub)) || sub.deploymentType === "active-active") continue;
      try {
        const res = await readViaTask<{ tgws?: RcTransitGateway[] }>(
          this.ctx,
          `/subscriptions/${sub.id}/transitGateways`,
        );
        for (const t of res?.tgws ?? []) out.push(mapTransitGateway(accountId, String(sub.id), t));
      } catch (err) {
        if (statusOf(err) === 401) throw err;
      }
    }
    return out;
  }

  private async pscService(subscriptionId: string): Promise<RcPscService | undefined> {
    try {
      return await readViaTask<RcPscService>(
        this.ctx,
        `/subscriptions/${subscriptionId}/private-service-connect`,
      );
    } catch (err) {
      if (statusOf(err) === 401) throw err;
      return undefined;
    }
  }

  private async listPscEndpoints(accountId: string): Promise<ResourceInstance[]> {
    const out: ResourceInstance[] = [];
    for (const sub of await this.proSubscriptions()) {
      if (sub.id === undefined || sub.status !== "active") continue;
      if (!/gcp/i.test(this.providerOf(sub)) || sub.deploymentType === "active-active") continue;
      const service = await this.pscService(String(sub.id));
      if (!service?.id) continue;
      try {
        const res = await readViaTask<{ endpoints?: RcPscEndpoint[] }>(
          this.ctx,
          `/subscriptions/${sub.id}/private-service-connect/${service.id}`,
        );
        for (const e of res?.endpoints ?? []) {
          out.push(mapPscEndpoint(accountId, String(sub.id), service, e));
        }
      } catch (err) {
        if (statusOf(err) === 401) throw err;
      }
    }
    return out;
  }

  private aclRules(): Promise<RcAclRule[]> {
    return this.cached("acl-rules", async () => {
      const res = await this.get<{ redisRules?: RcAclRule[] }>("/acl/redisRules");
      return res?.redisRules ?? [];
    });
  }

  private aclRoles(): Promise<RcAclRole[]> {
    return this.cached("acl-roles", async () => {
      const res = await this.get<{ roles?: RcAclRole[] }>("/acl/roles");
      return res?.roles ?? [];
    });
  }

  private aclUsers(): Promise<RcAclUser[]> {
    return this.cached("acl-users", async () => {
      const res = await this.get<{ users?: RcAclUser[] }>("/acl/users");
      return res?.users ?? [];
    });
  }

  private paymentMethods(): Promise<RcPaymentMethod[]> {
    return this.cached("payment-methods", async () => {
      const res = await this.get<{ paymentMethods?: RcPaymentMethod[] }>("/payment-methods");
      return res?.paymentMethods ?? [];
    });
  }

  /** A 403 on one listing means the key's role cannot see that type; list it empty. */
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
      case T.account: {
        const res = await this.get<{ account?: RcAccount }>("/");
        const methods = await this.paymentMethods().catch(() => undefined);
        return [mapAccount(accountId, res?.account ?? {}, methods?.length)];
      }
      case T.subscription:
        return this.scoped(async () => {
          const [pro, ess] = await Promise.all([
            this.proSubscriptions(),
            this.essentialsSubscriptions(),
          ]);
          return [
            ...pro.map((s) => mapProSubscription(accountId, s)),
            ...ess.map((s) => mapEssentialsSubscription(accountId, s)),
          ];
        });
      case T.database:
        return this.scoped(() => this.listDatabases(accountId));
      case T.vpcPeering:
        return this.scoped(() => this.listPeerings(accountId));
      case T.transitGateway:
        return this.scoped(() => this.listTransitGateways(accountId));
      case T.pscEndpoint:
        return this.scoped(() => this.listPscEndpoints(accountId));
      case T.aclRule:
        return this.scoped(async () =>
          (await this.aclRules()).map((r) => mapAclRule(accountId, r)),
        );
      case T.aclRole:
        return this.scoped(async () =>
          (await this.aclRoles()).map((r) => mapAclRole(accountId, r)),
        );
      case T.aclUser:
        return this.scoped(async () =>
          (await this.aclUsers()).map((u) => mapAclUser(accountId, u)),
        );
      case T.cloudAccount:
        return this.scoped(async () => {
          const res = await this.get<{ cloudAccounts?: RcCloudAccount[] }>("/cloud-accounts");
          return (res?.cloudAccounts ?? []).map((c) => mapCloudAccount(accountId, c));
        });
      default:
        throw new Error(`Redis Cloud plugin: unknown resource type "${typeId}"`);
    }
  }

  async getResource(
    typeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<ResourceInstance> {
    const externalId = externalIdOf(resourceId);
    if (typeId === T.database) {
      const ref = await this.dbRef(externalId, accountId);
      const db = await this.fetchDatabase(ref);
      return mapDatabase(accountId, db, ref);
    }
    const found = (await this.listResources(typeId, accountId)).find((r) => r.id === resourceId);
    if (!found) throw new Error(`Redis Cloud plugin: resource ${typeId}/${externalId} not found`);
    return found;
  }

  async resolveOutput(
    typeId: string,
    resourceId: string,
    outputKey: string,
    accountId: string,
  ): Promise<string> {
    if (typeId === T.subscription && outputKey === "prometheusEndpoint") {
      const parsed = parseSubscriptionExternalId(externalIdOf(resourceId));
      if (!parsed || parsed.kind !== "pro") return "";
      const sub = await this.get<RcProSubscription>(`/subscriptions/${parsed.id}`);
      return sub?.prometheusEndpoint ?? "";
    }
    if (typeId !== T.database) {
      throw new Error(`Redis Cloud plugin: cannot resolve "${outputKey}" for "${typeId}"`);
    }
    const ref = await this.dbRef(externalIdOf(resourceId), accountId);
    const db = await this.fetchDatabase(ref);
    const { host, port } = splitEndpoint(db.publicEndpoint || db.privateEndpoint);
    const password = db.security?.password ?? "";
    switch (outputKey) {
      case "host":
        return host;
      case "port":
        return port;
      case "password":
        return password;
      case "connectionString": {
        if (!host) throw new Error("This database has no endpoint yet.");
        const scheme = db.security?.enableTls ? "rediss" : "redis";
        const auth = password ? `default:${encodeURIComponent(password)}@` : "";
        return `${scheme}://${auth}${host}${port ? `:${port}` : ""}`;
      }
      default:
        throw new Error(`Redis Cloud plugin: unknown output "${outputKey}"`);
    }
  }

  // -------------------------------------------------------------------------
  // Detail
  // -------------------------------------------------------------------------

  async enrichDetail(resource: ResourceInstance): Promise<ResourceInstance> {
    const out: ResourceInstance = { ...resource, resolvedOutputs: { ...resource.resolvedOutputs } };
    const put = (key: string, value: unknown) => {
      if (value !== undefined) out.resolvedOutputs[key] = JSON.stringify(value);
    };
    const settle = async <T>(p: Promise<T>): Promise<T | undefined> => {
      try {
        return await p;
      } catch {
        return undefined;
      }
    };
    const ext = resource.externalId ?? externalIdOf(resource.id);
    switch (resource.resourceTypeId) {
      case T.database: {
        const ref = await this.dbRef(ext, resource.accountId);
        const base = this.dbPath(ref);
        const [versions, backup, tags, upgrade] = await Promise.all([
          settle(
            this.get<{ targets?: Array<string | { version?: string }> }>(
              `${base}/available-target-versions`,
            ),
          ),
          settle(this.get<RcTask>(`${base}/backup`)),
          settle(this.get<{ tags?: Array<{ key?: string; value?: string }> }>(`${base}/tags`)),
          settle(
            this.get<{ upgradeStatus?: string; targetRedisVersion?: string; progress?: number }>(
              `${base}/upgrade`,
            ),
          ),
        ]);
        put(
          ENRICH.versions,
          versions?.targets
            ?.map((t) => (typeof t === "string" ? t : t.version))
            .filter((v): v is string => !!v),
        );
        if (backup) put(ENRICH.backup, { status: backup.status, description: backup.description });
        put(ENRICH.tags, tags?.tags);
        if (upgrade?.upgradeStatus) put(ENRICH.upgrade, upgrade);
        if (ref.kind === "essentials") {
          const plans = await settle(this.essentialsPlansFor(ref.subscriptionId));
          if (plans) {
            put(
              ENRICH.plans,
              this.planOptions(plans, Number(resource.fields["memoryUsedMb"] ?? 0)),
            );
            const sub = (await this.essentialsSubscriptions()).find(
              (s) => String(s.id) === ref.subscriptionId,
            );
            const current = plans.find((p) => p.id === sub?.planId);
            if (current?.supportedAlerts) put(ENRICH.supportedAlerts, current.supportedAlerts);
          }
        }
        break;
      }
      case T.subscription: {
        const parsed = parseSubscriptionExternalId(ext);
        if (!parsed) break;
        if (parsed.kind === "essentials") {
          const plans = await settle(this.essentialsPlansFor(parsed.id));
          if (plans) put(ENRICH.plans, this.planOptions(plans, 0));
          break;
        }
        const sub = (await this.proSubscriptions()).find((s) => String(s.id) === parsed.id);
        const provider = sub ? this.providerOf(sub) : String(resource.fields["provider"] ?? "");
        const [pricing, maintenance, cidr] = await Promise.all([
          settle(this.proPricing(Number(parsed.id))),
          settle(this.get<unknown>(`/subscriptions/${parsed.id}/maintenance-windows`)),
          settle(readViaTask<unknown>(this.ctx, `/subscriptions/${parsed.id}/cidr`)),
        ]);
        put(ENRICH.pricing, pricing);
        put(ENRICH.maintenance, maintenance);
        put(ENRICH.cidr, cidr);
        if (/aws/i.test(provider) && sub?.deploymentType !== "active-active") {
          const inv = await settle(
            readViaTask<{ resources?: RcTgwInvitation[] }>(
              this.ctx,
              `/subscriptions/${parsed.id}/transitGateways/invitations`,
            ),
          );
          put(
            ENRICH.invitations,
            inv?.resources?.filter((i) => !/accepted/i.test(i.status ?? "")),
          );
        }
        if (/gcp/i.test(provider)) {
          const psc = await settle(this.pscService(parsed.id));
          if (psc?.id) put(ENRICH.psc, psc);
        }
        break;
      }
      case T.pscEndpoint: {
        const [sub, svc, ep] = ext.split("/");
        const base = `/subscriptions/${sub}/private-service-connect/${svc}/endpoints/${ep}`;
        const [creation, deletion] = await Promise.all([
          settle(readViaTask<{ script?: { bash?: string } }>(this.ctx, `${base}/creationScripts`)),
          settle(readViaTask<{ script?: { bash?: string } }>(this.ctx, `${base}/deletionScripts`)),
        ]);
        if (creation?.script?.bash)
          out.resolvedOutputs[ENRICH.creationScript] = creation.script.bash;
        if (deletion?.script?.bash)
          out.resolvedOutputs[ENRICH.deletionScript] = deletion.script.bash;
        break;
      }
      case T.aclRole: {
        const [rules, dbs] = await Promise.all([
          settle(this.aclRules()),
          settle(this.listDatabases(resource.accountId)),
        ]);
        put(
          ENRICH.ruleOptions,
          rules?.map((r) => ({ id: r.name ?? "", label: r.name ?? "" })),
        );
        put(
          ENRICH.databaseOptions,
          dbs?.map((d) => this.databaseOption(d)),
        );
        break;
      }
      case T.aclUser: {
        const roles = await settle(this.aclRoles());
        put(
          ENRICH.roleOptions,
          roles?.map((r) => ({ id: r.name ?? "", label: r.name ?? "" })),
        );
        break;
      }
      case T.account: {
        const [methods, tasks, users] = await Promise.all([
          settle(this.paymentMethods()),
          settle(this.get<RcTask[] | { tasks?: RcTask[] }>("/tasks")),
          settle(this.get<{ users?: unknown[] }>("/users")),
        ]);
        put(ENRICH.paymentMethods, methods);
        const taskList = Array.isArray(tasks) ? tasks : tasks?.tasks;
        put(
          ENRICH.tasks,
          taskList
            ?.slice()
            .sort((a, b) => String(b.timestamp ?? "").localeCompare(String(a.timestamp ?? ""))),
        );
        put(ENRICH.users, users?.users);
        break;
      }
    }
    return out;
  }

  private databaseOption(d: ResourceInstance): { id: string; label: string; category?: string } {
    return {
      id: `${d.fields["subscriptionId"]}/${d.externalId}`,
      label: d.displayName,
      category: String(d.fields["subscriptionName"] ?? d.fields["subscriptionId"] ?? ""),
    };
  }

  private essentialsPlansFor(subscriptionId: string): Promise<RcEssentialsPlan[]> {
    return this.cached(`ess-plans-${subscriptionId}`, async () => {
      const res = await this.get<{ plans?: RcEssentialsPlan[] }>(
        `/fixed/plans/subscriptions/${subscriptionId}`,
      );
      return res?.plans ?? [];
    });
  }

  private planOptions(plans: RcEssentialsPlan[], usedMb: number) {
    return plans
      .filter((p) => p.id !== undefined)
      .filter((p) => {
        const sizeMb =
          String(p.sizeMeasurementUnit ?? "GB").toUpperCase() === "MB"
            ? Number(p.size ?? 0)
            : Number(p.size ?? 0) * 1024;
        return !usedMb || sizeMb >= usedMb * 1.1;
      })
      .sort((a, b) => Number(a.price ?? 0) - Number(b.price ?? 0))
      .map((p) => ({
        id: String(p.id),
        label: p.name ?? String(p.id),
        description: [
          p.size !== undefined ? `${p.size} ${p.sizeMeasurementUnit ?? "GB"}` : "",
          p.availability ?? "",
          p.price !== undefined
            ? `${p.price} ${p.priceCurrency ?? "USD"}/${(p.pricePeriod ?? "month").toLowerCase()}`
            : "",
        ]
          .filter(Boolean)
          .join(" · "),
      }));
  }

  renderDetail(resource: ResourceInstance): DetailViewSchema {
    return withMetricsCapability(
      renderRedisCloudDetail(resource),
      RESOURCE_TYPES,
      resource.resourceTypeId,
      METRICS_WINDOW_MS,
    );
  }

  renderSidebarItem(resource: ResourceInstance): SidebarItemSchema {
    return renderRedisCloudSidebar(resource);
  }

  // -------------------------------------------------------------------------
  // Create / update / delete
  // -------------------------------------------------------------------------

  private async parentSubscription(parentResourceId: string | undefined, fallback?: string) {
    const ext = parentResourceId ? externalIdOf(parentResourceId) : (fallback ?? "");
    const parsed = parseSubscriptionExternalId(ext);
    if (!parsed) throw new Error("Pick a subscription first.");
    return parsed;
  }

  private async subscriptionOptions(kind?: PlanKind) {
    const [pro, ess] = await Promise.all([this.proSubscriptions(), this.essentialsSubscriptions()]);
    return [
      ...(kind === "essentials" ? [] : pro).map((s) => ({
        id: subscriptionExternalId("pro", s.id ?? ""),
        label: s.name ?? String(s.id),
        description: `Pro · ${this.providerOf(s)}`,
      })),
      ...(kind === "pro" ? [] : ess).map((s) => ({
        id: subscriptionExternalId("essentials", s.id ?? ""),
        label: s.name ?? String(s.id),
        description: `Essentials · ${s.planName ?? ""}`,
      })),
    ];
  }

  async getCreateConfig(typeId: string, parentResourceId?: string): Promise<CreateResourceConfig> {
    switch (typeId) {
      case T.database: {
        const parent = parentResourceId
          ? parseSubscriptionExternalId(externalIdOf(parentResourceId))
          : null;
        const isPro = parent?.kind === "pro";
        const isEss = parent?.kind === "essentials";
        return {
          fields: [
            ...(parent
              ? []
              : [
                  {
                    key: "subscription",
                    label: "Subscription",
                    kind: "select" as const,
                    required: true,
                    options: await this.subscriptionOptions(),
                  },
                ]),
            {
              key: "name",
              label: "Name",
              kind: "text",
              required: true,
              placeholder: "cache-prod",
              description: "Up to 40 letters, digits and hyphens; starts with a letter.",
            },
            ...(isEss
              ? []
              : [
                  {
                    key: "datasetSizeInGb",
                    label: "Dataset size (GB)",
                    kind: "number" as const,
                    required: !parent || isPro,
                    minValue: 0.1,
                    stepValue: 0.1,
                    defaultValue: "1",
                    description: "Pro only. Essentials databases take their size from the plan.",
                  },
                  {
                    key: "throughput",
                    label: "Throughput (ops/sec)",
                    kind: "number" as const,
                    required: false,
                    minValue: 100,
                    stepValue: 100,
                    defaultValue: "1000",
                    description: "Pro only.",
                  },
                ]),
            {
              key: "replication",
              label: "Replication",
              kind: "select",
              required: false,
              options: [
                { id: "true", label: "On (high availability)" },
                { id: "false", label: "Off" },
              ],
              defaultValue: "true",
            },
            {
              key: "dataPersistence",
              label: "Persistence",
              kind: "select",
              required: false,
              options: PERSISTENCE_OPTIONS.map((p) => ({ id: p, label: p })),
              defaultValue: "none",
            },
            {
              key: "dataEvictionPolicy",
              label: "Eviction policy",
              kind: "select",
              required: false,
              options: EVICTION_OPTIONS.map((p) => ({ id: p, label: p })),
              defaultValue: "volatile-lru",
            },
            {
              key: "enableTls",
              label: "Require TLS",
              kind: "select",
              required: false,
              options: [
                { id: "true", label: "Yes" },
                { id: "false", label: "No" },
              ],
              defaultValue: "true",
            },
            {
              key: "password",
              label: "Default user password",
              kind: "text",
              required: false,
              description:
                "Leave blank and Redis Cloud generates one; it is readable from the database's outputs.",
            },
          ],
        };
      }
      case T.vpcPeering: {
        const parent = await this.parentSubscription(parentResourceId).catch(() => null);
        const sub = parent
          ? (await this.proSubscriptions()).find((s) => String(s.id) === parent.id)
          : undefined;
        const provider = sub ? this.providerOf(sub) : "";
        const gcp = /gcp/i.test(provider);
        return {
          fields: [
            ...(parent
              ? []
              : [
                  {
                    key: "subscription",
                    label: "Subscription",
                    kind: "select" as const,
                    required: true,
                    options: await this.subscriptionOptions("pro"),
                  },
                ]),
            ...(gcp
              ? [
                  {
                    key: "vpcProjectUid",
                    label: "Google Cloud project ID",
                    kind: "text" as const,
                    required: true,
                  },
                  {
                    key: "vpcNetworkName",
                    label: "VPC network name",
                    kind: "text" as const,
                    required: true,
                  },
                ]
              : [
                  {
                    key: "region",
                    label: "AWS region of your VPC",
                    kind: "select" as const,
                    required: true,
                    options: await this.awsRegionOptions(),
                    ...(sub?.cloudDetails?.[0]?.regions?.[0]?.region
                      ? { defaultValue: sub.cloudDetails[0].regions[0].region }
                      : {}),
                  },
                  {
                    key: "awsAccountId",
                    label: "AWS account ID",
                    kind: "text" as const,
                    required: true,
                    placeholder: "123456789012",
                  },
                  {
                    key: "vpcId",
                    label: "VPC ID",
                    kind: "text" as const,
                    required: true,
                    placeholder: "vpc-0123456789abcdef0",
                  },
                  {
                    key: "vpcCidrs",
                    label: "VPC CIDRs",
                    kind: "string-list" as const,
                    required: true,
                    placeholder: "10.10.0.0/16",
                  },
                ]),
          ],
        };
      }
      case T.pscEndpoint:
        return {
          fields: [
            { key: "gcpProjectId", label: "Google Cloud project ID", kind: "text", required: true },
            { key: "gcpVpcName", label: "VPC network name", kind: "text", required: true },
            { key: "gcpVpcSubnetName", label: "Subnet name", kind: "text", required: true },
            {
              key: "endpointConnectionName",
              label: "Endpoint name prefix",
              kind: "text",
              required: true,
              description: "Google Cloud names the endpoints prefix + number.",
            },
          ],
        };
      case T.aclRule:
        return {
          fields: [
            { key: "name", label: "Name", kind: "text", required: true, placeholder: "cache-read" },
            {
              key: "rule",
              label: "Rule",
              kind: "text",
              required: true,
              placeholder: "+@read ~cache:*",
              description: "Redis ACL syntax: +@category or +command to allow, ~pattern for keys.",
            },
          ],
        };
      case T.aclRole: {
        const [rules, dbs] = await Promise.all([this.aclRules(), this.listDatabases("create")]);
        return {
          fields: roleFormFields(
            rules.map((r) => ({ id: r.name ?? "", label: r.name ?? "" })),
            dbs.map((d) => this.databaseOption(d)),
          ),
        };
      }
      case T.aclUser: {
        const roles = await this.aclRoles();
        return {
          fields: [
            { key: "name", label: "Name", kind: "text", required: true },
            {
              key: "role",
              label: "Role",
              kind: "select",
              required: true,
              options: roles.map((r) => ({ id: r.name ?? "", label: r.name ?? "" })),
            },
            {
              key: "password",
              label: "Password",
              kind: "text",
              required: true,
              description:
                "Needs a lowercase letter, an uppercase letter, a number and a special character.",
            },
          ],
        };
      }
      default:
        throw new Error(`Redis Cloud plugin: creating "${typeId}" is not supported`);
    }
  }

  private async awsRegionOptions() {
    const res = await this.get<{ regions?: Array<{ name?: string; provider?: string }> }>(
      "/regions",
    ).catch(() => ({ regions: [] }));
    return (res?.regions ?? [])
      .filter((r) => /aws/i.test(r.provider ?? "") && r.name)
      .map((r) => ({ id: r.name!, label: r.name! }));
  }

  async createResource(
    typeId: string,
    accountId: string,
    fields: Record<string, string>,
    parentResourceId?: string,
  ): Promise<ResourceInstance> {
    this.invalidate();
    switch (typeId) {
      case T.database: {
        const parent = await this.parentSubscription(parentResourceId, fields["subscription"]);
        const name = (fields["name"] ?? "").trim();
        if (!/^[a-zA-Z][a-zA-Z0-9-]{0,38}[a-zA-Z0-9]$|^[a-zA-Z]$/.test(name)) {
          throw new Error(
            "Name must be up to 40 letters, digits and hyphens, starting with a letter and not ending with a hyphen.",
          );
        }
        const body: Record<string, unknown> = { name };
        const replication = bool(fields["replication"]);
        if (replication !== undefined) body["replication"] = replication;
        if (fields["dataPersistence"]) body["dataPersistence"] = fields["dataPersistence"];
        if (fields["dataEvictionPolicy"]) body["dataEvictionPolicy"] = fields["dataEvictionPolicy"];
        const tls = bool(fields["enableTls"]);
        if (tls !== undefined) body["enableTls"] = tls;
        if (fields["password"]) body["password"] = fields["password"];
        let path: string;
        if (parent.kind === "pro") {
          const size = Number(fields["datasetSizeInGb"]);
          if (!Number.isFinite(size) || size < 0.1)
            throw new Error("Dataset size must be at least 0.1 GB.");
          body["datasetSizeInGb"] = size;
          const ops = Number(fields["throughput"] || 1000);
          body["throughputMeasurement"] = { by: "operations-per-second", value: ops };
          path = `/subscriptions/${parent.id}/databases`;
        } else {
          path = `/fixed/subscriptions/${parent.id}/databases`;
        }
        const { task } = await submitTask(this.ctx, "POST", path, body, 30_000);
        const dbId = task.response?.resourceId;
        const ctx: DatabaseContext = { kind: parent.kind, subscriptionId: parent.id };
        if (dbId !== undefined) {
          this.dbIndex.set(String(dbId), { ...ctx, databaseId: String(dbId) });
          return mapDatabase(accountId, { databaseId: dbId, name, status: "pending" }, ctx);
        }
        return mapDatabase(accountId, { databaseId: 0, name, status: "pending" }, ctx);
      }
      case T.vpcPeering: {
        const parent = await this.parentSubscription(parentResourceId, fields["subscription"]);
        const body: Record<string, unknown> = fields["vpcProjectUid"]
          ? {
              provider: "GCP",
              vpcProjectUid: fields["vpcProjectUid"],
              vpcNetworkName: fields["vpcNetworkName"],
            }
          : {
              provider: "AWS",
              region: fields["region"],
              awsAccountId: fields["awsAccountId"],
              vpcId: fields["vpcId"],
              vpcCidrs: csv(fields["vpcCidrs"]),
            };
        const { task } = await submitTask(
          this.ctx,
          "POST",
          `/subscriptions/${parent.id}/peerings`,
          body,
          30_000,
        );
        return mapVpcPeering(accountId, parent.id, String(body["provider"]), {
          vpcPeeringId: task.response?.resourceId ?? 0,
          status: "pending-acceptance",
          vpcUid: fields["vpcId"],
          awsAccountId: fields["awsAccountId"],
          projectUid: fields["vpcProjectUid"],
          networkName: fields["vpcNetworkName"],
        });
      }
      case T.pscEndpoint: {
        const parent = await this.parentSubscription(parentResourceId, fields["subscription"]);
        let service = await this.pscService(parent.id);
        if (!service?.id) {
          await submitTask(
            this.ctx,
            "POST",
            `/subscriptions/${parent.id}/private-service-connect`,
            undefined,
            60_000,
          );
          service = await this.pscService(parent.id);
        }
        if (!service?.id)
          throw new Error(
            "Private Service Connect is still being set up for this subscription; try again shortly.",
          );
        const body = {
          gcpProjectId: fields["gcpProjectId"],
          gcpVpcName: fields["gcpVpcName"],
          gcpVpcSubnetName: fields["gcpVpcSubnetName"],
          endpointConnectionName: fields["endpointConnectionName"],
        };
        const { task } = await submitTask(
          this.ctx,
          "POST",
          `/subscriptions/${parent.id}/private-service-connect/${service.id}`,
          body,
          30_000,
        );
        return mapPscEndpoint(accountId, parent.id, service, {
          id: task.response?.resourceId ?? 0,
          status: "initialized",
          ...body,
        });
      }
      case T.aclRule: {
        const { task } = await submitTask(this.ctx, "POST", "/acl/redisRules", {
          name: fields["name"],
          redisRule: fields["rule"],
        });
        return mapAclRule(accountId, {
          id: task.response?.resourceId ?? 0,
          name: fields["name"] ?? "",
          acl: fields["rule"] ?? "",
          status: "pending",
        });
      }
      case T.aclRole: {
        const body = { name: fields["name"], redisRules: this.roleRules(fields) };
        const { task } = await submitTask(this.ctx, "POST", "/acl/roles", body);
        return mapAclRole(accountId, {
          id: task.response?.resourceId ?? 0,
          name: fields["name"] ?? "",
          status: "pending",
        });
      }
      case T.aclUser: {
        const { task } = await submitTask(this.ctx, "POST", "/acl/users", {
          name: fields["name"],
          role: fields["role"],
          password: fields["password"],
        });
        return mapAclUser(accountId, {
          id: task.response?.resourceId ?? 0,
          name: fields["name"] ?? "",
          role: fields["role"] ?? "",
          status: "pending",
        });
      }
      default:
        throw new Error(`Redis Cloud plugin: creating "${typeId}" is not supported`);
    }
  }

  private roleRules(fields: Record<string, string>) {
    let keys: string[] = [];
    try {
      const parsed = JSON.parse(fields["databases"] || "[]") as unknown;
      if (Array.isArray(parsed)) keys = parsed.map(String);
    } catch {
      keys = csv(fields["databases"]);
    }
    if (!fields["ruleName"]) throw new Error("Pick an ACL rule.");
    if (keys.length === 0) throw new Error("Pick at least one database.");
    return [
      {
        ruleName: fields["ruleName"],
        databases: keys.map((k) => {
          const [sub, db] = k.split("/");
          return { subscriptionId: Number(sub), databaseId: Number(db) };
        }),
      },
    ];
  }

  async updateResource(
    typeId: string,
    resourceId: string,
    accountId: string,
    fields: Record<string, string>,
  ): Promise<ResourceInstance> {
    const ext = externalIdOf(resourceId);
    this.invalidate();
    switch (typeId) {
      case T.subscription: {
        const parsed = parseSubscriptionExternalId(ext);
        if (!parsed) throw new Error("Unknown subscription");
        const body: Record<string, unknown> = {};
        if (fields["name"] !== undefined) body["name"] = fields["name"];
        if (parsed.kind === "pro" && fields["publicEndpointAccess"] !== undefined) {
          body["publicEndpointAccess"] = bool(fields["publicEndpointAccess"]);
        }
        if (Object.keys(body).length) {
          await submitTask(
            this.ctx,
            "PUT",
            parsed.kind === "pro"
              ? `/subscriptions/${parsed.id}`
              : `/fixed/subscriptions/${parsed.id}`,
            body,
          );
        }
        break;
      }
      case T.database: {
        const ref = await this.dbRef(ext, accountId);
        const body: Record<string, unknown> = {};
        if (fields["name"] !== undefined) body["name"] = fields["name"];
        if (fields["replication"] !== undefined) body["replication"] = bool(fields["replication"]);
        if (fields["dataPersistence"]) body["dataPersistence"] = fields["dataPersistence"];
        if (fields["dataEvictionPolicy"]) body["dataEvictionPolicy"] = fields["dataEvictionPolicy"];
        if (fields["enableTls"] !== undefined) body["enableTls"] = bool(fields["enableTls"]);
        if (fields["defaultUserEnabled"] !== undefined)
          body["enableDefaultUser"] = bool(fields["defaultUserEnabled"]);
        if (fields["sourceIps"] !== undefined) {
          body[ref.kind === "pro" ? "sourceIp" : "sourceIps"] = csv(fields["sourceIps"]);
        }
        if (fields["password"]) body["password"] = fields["password"];
        if (Object.keys(body).length) await submitTask(this.ctx, "PUT", this.dbPath(ref), body);
        break;
      }
      case T.vpcPeering: {
        const [sub, peering] = ext.split("/");
        if (fields["vpcCidrs"] !== undefined) {
          await submitTask(this.ctx, "PUT", `/subscriptions/${sub}/peerings/${peering}`, {
            vpcCidrs: csv(fields["vpcCidrs"]),
          });
        }
        break;
      }
      case T.transitGateway: {
        const [sub, tgw] = ext.split("/");
        if (fields["cidrs"] !== undefined) {
          await submitTask(
            this.ctx,
            "PUT",
            `/subscriptions/${sub}/transitGateways/${tgw}/attachment`,
            {
              cidrs: csv(fields["cidrs"]).map((cidrAddress) => ({ cidrAddress })),
            },
          );
        }
        break;
      }
      case T.aclRule: {
        const current = (await this.aclRules()).find((r) => String(r.id) === ext);
        await submitTask(this.ctx, "PUT", `/acl/redisRules/${ext}`, {
          name: fields["name"] ?? current?.name,
          redisRule: fields["rule"] ?? current?.acl,
        });
        break;
      }
      case T.aclRole:
        if (fields["name"] !== undefined) {
          await submitTask(this.ctx, "PUT", `/acl/roles/${ext}`, { name: fields["name"] });
        }
        break;
      case T.aclUser:
        if (fields["password"]) {
          await submitTask(this.ctx, "PUT", `/acl/users/${ext}`, { password: fields["password"] });
        }
        break;
      default:
        throw new Error(`Redis Cloud plugin: updating "${typeId}" is not supported`);
    }
    this.invalidate();
    return this.getResource(typeId, resourceId, accountId);
  }

  async deleteResource(typeId: string, resourceId: string, accountId: string): Promise<void> {
    const ext = externalIdOf(resourceId);
    this.invalidate();
    let path: string;
    switch (typeId) {
      case T.subscription: {
        const parsed = parseSubscriptionExternalId(ext);
        if (!parsed) throw new Error("Unknown subscription");
        path =
          parsed.kind === "pro"
            ? `/subscriptions/${parsed.id}`
            : `/fixed/subscriptions/${parsed.id}`;
        break;
      }
      case T.database:
        path = this.dbPath(await this.dbRef(ext, accountId));
        break;
      case T.vpcPeering: {
        const [sub, peering] = ext.split("/");
        path = `/subscriptions/${sub}/peerings/${peering}`;
        break;
      }
      case T.pscEndpoint: {
        const [sub, svc, ep] = ext.split("/");
        path = `/subscriptions/${sub}/private-service-connect/${svc}/endpoints/${ep}`;
        break;
      }
      case T.aclRule:
        path = `/acl/redisRules/${ext}`;
        break;
      case T.aclRole:
        path = `/acl/roles/${ext}`;
        break;
      case T.aclUser:
        path = `/acl/users/${ext}`;
        break;
      case T.cloudAccount:
        path = `/cloud-accounts/${ext}`;
        break;
      default:
        throw new Error(`Redis Cloud plugin: deleting "${typeId}" is not supported`);
    }
    await submitTask(this.ctx, "DELETE", path, undefined, 15_000);
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
    const ext = externalIdOf(resourceId);
    this.invalidate();
    if (typeId === T.database && actionId === "flush") {
      const ref = await this.dbRef(ext, accountId);
      if (ref.kind !== "pro") throw new Error("Flush is only available for Pro databases.");
      await submitTask(this.ctx, "PUT", `${this.dbPath(ref)}/flush`, {});
      return;
    }
    if (typeId === T.subscription) {
      const parsed = parseSubscriptionExternalId(ext);
      if (!parsed) throw new Error("Unknown subscription");
      const inv = /^tgw-(accept|reject):(\d+)$/.exec(actionId);
      if (inv) {
        await submitTask(
          this.ctx,
          "PUT",
          `/subscriptions/${parsed.id}/transitGateways/invitations/${inv[2]}/${inv[1]}`,
          {},
        );
        return;
      }
      if (actionId === "psc-setup") {
        await submitTask(
          this.ctx,
          "POST",
          `/subscriptions/${parsed.id}/private-service-connect`,
          undefined,
        );
        return;
      }
    }
    if (typeId === T.transitGateway) {
      const [sub, tgw] = ext.split("/");
      if (actionId === "tgw-attach") {
        await submitTask(
          this.ctx,
          "POST",
          `/subscriptions/${sub}/transitGateways/${tgw}/attachment`,
          undefined,
        );
        return;
      }
      if (actionId === "tgw-detach") {
        await submitTask(
          this.ctx,
          "DELETE",
          `/subscriptions/${sub}/transitGateways/${tgw}/attachment`,
          undefined,
        );
        return;
      }
    }
    if (typeId === T.pscEndpoint && actionId === "psc-accept") {
      const [sub, svc, ep] = ext.split("/");
      await submitTask(
        this.ctx,
        "PUT",
        `/subscriptions/${sub}/private-service-connect/${svc}/endpoints/${ep}`,
        {
          action: "accept",
        },
      );
      return;
    }
    throw new Error(`Redis Cloud plugin: unknown action "${actionId}" for "${typeId}"`);
  }

  async executeNoSqlCommand(
    typeId: string,
    resourceId: string,
    accountId: string,
    command: string,
    args: (string | number)[],
  ): Promise<unknown> {
    const form = decodePromptArgs(args);
    const ext = externalIdOf(resourceId);
    this.invalidate();
    if (typeId === T.database) {
      const ref = await this.dbRef(ext, accountId);
      const base = this.dbPath(ref);
      switch (command) {
        case "resize-memory": {
          if (ref.kind !== "pro")
            throw new Error("Essentials databases change size through their plan.");
          const size = Number(form["datasetSizeInGb"]);
          if (!Number.isFinite(size) || size < 0.1)
            throw new Error("Dataset size must be at least 0.1 GB.");
          if (Math.round(size * 10) !== size * 10)
            throw new Error("Dataset size goes in steps of 0.1 GB.");
          const db = await this.fetchDatabase(ref);
          const usedGb = Number(db.memoryUsedInMb ?? 0) / 1024;
          const minGb = minDatasetGb(Number(db.memoryUsedInMb ?? 0));
          if (size < minGb) {
            throw new Error(
              `The database already holds ${Math.round(usedGb * 100) / 100} GB; choose at least ${minGb} GB.`,
            );
          }
          const dryRun = form["dryRun"] === "true";
          const { finished } = await submitTask(
            this.ctx,
            "PUT",
            base,
            { datasetSizeInGb: size, ...(dryRun ? { dryRun: true } : {}) },
            30_000,
          );
          return finishedMessage(finished, dryRun ? "Validation" : "Resize");
        }
        case "change-plan":
          return this.changePlan(
            ref.subscriptionId,
            form["planId"],
            Number((await this.fetchDatabase(ref)).memoryUsedInMb ?? 0),
          );
        case "set-alerts": {
          const alerts: Array<{ name: string; value: number }> = [];
          for (const [name, raw] of Object.entries(form)) {
            if (raw === undefined || raw === "") continue;
            const def = alertDefinition(name);
            if (!def) continue;
            const value = Number(raw);
            if (!Number.isInteger(value) || value < def.min || value > def.max) {
              throw new Error(`${def.label} must be a whole number from ${def.min} to ${def.max}.`);
            }
            alerts.push({ name, value });
          }
          const { finished } = await submitTask(this.ctx, "PUT", base, { alerts });
          return finishedMessage(finished, "Alert update");
        }
        case "backup": {
          const body = form["adhocBackupPath"] ? { adhocBackupPath: form["adhocBackupPath"] } : {};
          const { finished } = await submitTask(this.ctx, "POST", `${base}/backup`, body);
          return finishedMessage(finished, "Backup");
        }
        case "import": {
          const uris = csv(form["importFromUri"]);
          if (!form["sourceType"] || uris.length === 0)
            throw new Error("Pick a source and give at least one URI.");
          const { finished } = await submitTask(this.ctx, "POST", `${base}/import`, {
            sourceType: form["sourceType"],
            importFromUri: uris,
          });
          return finishedMessage(finished, "Import");
        }
        case "upgrade-version": {
          if (!form["targetRedisVersion"]) throw new Error("Pick a version.");
          const { finished } = await submitTask(this.ctx, "POST", `${base}/upgrade`, {
            targetRedisVersion: form["targetRedisVersion"],
          });
          return finishedMessage(finished, "Upgrade");
        }
        case "set-tags": {
          const tags = csv(form["tags"]).map((t) => {
            const idx = t.indexOf("=");
            const key = (idx < 0 ? t : t.slice(0, idx)).trim();
            const value = idx < 0 ? "" : t.slice(idx + 1).trim();
            if (!key || key !== key.toLowerCase() || value !== value.toLowerCase()) {
              throw new Error(`Tag "${t}" must be key=value in lowercase.`);
            }
            return { key, value };
          });
          await rcFetch(this.ctx, "PUT", `${base}/tags`, { tags });
          return { ok: true, message: "Tags saved." };
        }
      }
    }
    if (typeId === T.subscription) {
      const parsed = parseSubscriptionExternalId(ext);
      if (!parsed) throw new Error("Unknown subscription");
      switch (command) {
        case "change-plan":
          return this.changePlan(parsed.id, form["planId"], 0);
        case "set-maintenance": {
          const mode = form["mode"] === "manual" ? "manual" : "automatic";
          const body: Record<string, unknown> = { mode };
          if (mode === "manual") {
            let days: string[] = [];
            try {
              days = JSON.parse(form["days"] || "[]") as string[];
            } catch {
              days = csv(form["days"]);
            }
            const startHour = Number(form["startHour"]);
            const duration = Number(form["durationInHours"]);
            if (days.length === 0) throw new Error("Pick at least one day.");
            if (!Number.isInteger(startHour) || startHour < 0 || startHour > 23)
              throw new Error("Start hour must be 0 to 23.");
            if (!Number.isInteger(duration) || duration < 4 || duration > 24)
              throw new Error("Duration must be 4 to 24 hours.");
            body["windows"] = [{ startHour, durationInHours: duration, days }];
          }
          await submitTask(
            this.ctx,
            "PUT",
            `/subscriptions/${parsed.id}/maintenance-windows`,
            body,
          );
          return { ok: true, message: "Maintenance windows saved." };
        }
        case "set-cidr": {
          const { finished } = await submitTask(
            this.ctx,
            "PUT",
            `/subscriptions/${parsed.id}/cidr`,
            {
              cidrIps: csv(form["cidrIps"]),
              securityGroupIds: csv(form["securityGroupIds"]),
            },
          );
          return finishedMessage(finished, "Allow list update");
        }
      }
    }
    if (typeId === T.aclRole && command === "set-role-rules") {
      await submitTask(this.ctx, "PUT", `/acl/roles/${ext}`, { redisRules: this.roleRules(form) });
      return { ok: true, message: "Role updated." };
    }
    if (typeId === T.aclUser && command === "set-user-role") {
      if (!form["role"]) throw new Error("Pick a role.");
      await submitTask(this.ctx, "PUT", `/acl/users/${ext}`, { role: form["role"] });
      return { ok: true, message: "Role changed." };
    }
    throw new Error(`Redis Cloud plugin: command "${command}" is not supported for "${typeId}"`);
  }

  private async changePlan(subscriptionId: string, planId: string | undefined, usedMb: number) {
    if (!planId) throw new Error("Pick a plan.");
    const plans = await this.essentialsPlansFor(subscriptionId);
    const plan = plans.find((p) => String(p.id) === planId);
    if (!plan) throw new Error("That plan is not compatible with this subscription.");
    const sizeMb =
      String(plan.sizeMeasurementUnit ?? "GB").toUpperCase() === "MB"
        ? Number(plan.size ?? 0)
        : Number(plan.size ?? 0) * 1024;
    if (usedMb && sizeMb < usedMb * 1.1) {
      throw new Error(
        `The data already stored (${usedMb} MB) does not fit in ${plan.name ?? "that plan"}.`,
      );
    }
    const { finished } = await submitTask(
      this.ctx,
      "PUT",
      `/fixed/subscriptions/${subscriptionId}`,
      { planId: Number(planId) },
      30_000,
    );
    return finishedMessage(finished, "Plan change");
  }

  // -------------------------------------------------------------------------
  // Observability
  // -------------------------------------------------------------------------

  async fetchMetricSeries(
    resourceTypeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<MetricSeries[]> {
    if (resourceTypeId !== T.database) return [];
    const ref = await this.dbRef(externalIdOf(resourceId), accountId);
    const db = await this.get<RcDatabase>(this.dbPath(ref));
    const now = Date.now();
    const series = memorySeries(db.memoryUsedInMb, databaseDatasetGb(db), now);
    if (ref.kind === "pro") {
      const sub = (await this.proSubscriptions()).find((s) => String(s.id) === ref.subscriptionId);
      if (sub?.prometheusEndpoint) {
        const samples = await scrapePrometheus(sub.prometheusEndpoint, this.http);
        if (samples) series.push(...prometheusSeries(samples, ref.databaseId, now));
      }
    }
    return series;
  }

  async fetchDashboardStats(
    resourceTypeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<DashboardStat[]> {
    const resource = await this.getResource(resourceTypeId, resourceId, accountId);
    const f = resource.fields;
    const statusVariant = (s: unknown): NonNullable<DashboardStat["variant"]> =>
      String(s ?? "").toLowerCase() === "active" ? "status-healthy" : "status-degraded";
    if (resourceTypeId === T.database) {
      return [
        { label: "Status", value: String(f["status"] ?? ""), variant: statusVariant(f["status"]) },
        {
          label: "Memory",
          value:
            f["memoryUsedMb"] !== undefined
              ? `${f["memoryUsedMb"]} MB / ${f["datasetSizeGb"] ?? "?"} GB`
              : "",
        },
        { label: "Throughput", value: String(f["throughput"] ?? "") },
        { label: "Version", value: String(f["redisVersion"] ?? "") },
      ];
    }
    if (resourceTypeId === T.subscription) {
      return [
        { label: "Status", value: String(f["status"] ?? ""), variant: statusVariant(f["status"]) },
        { label: "Plan", value: String(f["planName"] ?? f["plan"] ?? "") },
        { label: "Databases", value: String(f["numberOfDatabases"] ?? "") },
        {
          label: "List price",
          value:
            f["monthlyPrice"] !== undefined
              ? `${f["monthlyPrice"]} ${f["priceCurrency"] ?? "USD"}/mo`
              : "",
        },
      ];
    }
    return [{ label: "Status", value: String(f["status"] ?? "") }];
  }

  async getLogs(
    typeId: string,
    resourceId: string,
    accountId: string,
    params: LogsFetchParams,
  ): Promise<LogsFetchResult> {
    const tail = Math.min(Math.max(params.tailLines ?? 100, 1), 1000);
    const stamp = (s?: string) =>
      String(s ?? "")
        .replace("T", " ")
        .replace(/(\.\d+)?Z$/, "");
    if (typeId === T.database) {
      const containers = ["Slow log", "System log"];
      const active =
        params.container && containers.includes(params.container) ? params.container : "Slow log";
      const ref = await this.dbRef(externalIdOf(resourceId), accountId);
      if (active === "Slow log") {
        const res = await this.get<{ entries?: RcSlowLogEntry[] }>(`${this.dbPath(ref)}/slow-log`);
        const text = (res?.entries ?? [])
          .slice(0, tail)
          .reverse()
          .map(
            (e) =>
              `${stamp(e.startTime)}  ${String(e.duration ?? "?").padStart(8)} µs  ${e.arguments ?? ""}\n`,
          )
          .join("");
        return {
          text: text || "No slow commands recorded.\n",
          containers,
          activeContainer: active,
        };
      }
      const res = await this.get<{ entries?: RcSystemLogEntry[] }>("/logs", {
        limit: tail,
        resourceId: Number(ref.databaseId),
      });
      return {
        text: this.systemLogText(res?.entries ?? [], stamp),
        containers,
        activeContainer: active,
      };
    }
    const containers = ["System log", "Session log"];
    const active =
      params.container && containers.includes(params.container) ? params.container : "System log";
    if (active === "Session log") {
      const res = await this.get<{
        entries?: Array<{
          time?: string;
          user?: string;
          userAgent?: string;
          ipAddress?: string;
          userRole?: string;
          type?: string;
          action?: string;
        }>;
      }>("/session-logs", { limit: Math.min(tail, 100) });
      const text = (res?.entries ?? [])
        .slice()
        .reverse()
        .map(
          (e) =>
            `${stamp(e.time)}  ${e.action ?? e.type ?? ""}  ${e.user ?? ""}${e.userRole ? ` (${e.userRole})` : ""}${e.ipAddress ? ` from ${e.ipAddress}` : ""}\n`,
        )
        .join("");
      return { text, containers, activeContainer: active };
    }
    const res = await this.get<{ entries?: RcSystemLogEntry[] }>("/logs", { limit: tail });
    return {
      text: this.systemLogText(res?.entries ?? [], stamp),
      containers,
      activeContainer: active,
    };
  }

  private systemLogText(entries: RcSystemLogEntry[], stamp: (s?: string) => string): string {
    return entries
      .slice()
      .reverse()
      .map(
        (e) =>
          `${stamp(e.time)}  ${(e.type ?? "").padEnd(12)}  ${e.description ?? ""}${e.originator ? `  [${e.originator}${e.apiKeyName ? ` via ${e.apiKeyName}` : ""}]` : ""}\n`,
      )
      .join("");
  }

  fetchCostData(_accountId: string, range: CostFetchRange): Promise<CostRow[] | CostFetchResult> {
    return fetchRedisCloudCostData(this.ctx, this, range);
  }
}
