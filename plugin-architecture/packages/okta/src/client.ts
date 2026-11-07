import type { Credentials } from "./plugin.js";
import { attempt, runPluginEffect } from "@infrawrench/plugin-base/effect";
import type { ApiAnswer, PluginEffect } from "@infrawrench/plugin-base";
import type {
  CreateResourceConfig,
  DashboardStat,
  DetailViewSchema,
  HostServices,
  LogsFetchParams,
  LogsFetchResult,
  MetricSeries,
  PluginClient,
  PolicyOption,
  PreflightCapabilityCheck,
  PreflightResult,
  QuotaUsage,
  ResourceInstance,
  SeatFetchOptions,
  SeatRecord,
  SeatRef,
  SeatRemovalResult,
  SelectOption,
  SidebarItemSchema,
} from "@infrawrench/plugin-base";
import { externalIdOf, pathEncode, rethrowIncompleteList } from "@infrawrench/plugin-base";
import { OktaApi, readCredentials, type Schemas } from "./api.js";
import { renderDetail, renderSidebarItem } from "./render.js";
import { mapOktaSeat, oktaSeatPrice } from "./seats.js";
const PLUGIN_ID = "okta";

export const METRICS_DEFAULT_RANGE_MS = 24 * 60 * 60 * 1000;
const METRIC_BUCKETS = 48;
/** System Log pages (1000 events each) read for one metrics window. */
const MAX_LOG_PAGES = 5;
/** Pages of a list a detail view shows and its pickers choose from, far past any real one. */
const DETAIL_LIST_PAGES = 50;
/** The host cannot prune past about this many live rows of one account (#572). */
const MAX_LIST_ROWS = 50_000;

function pagesFor(pageSize: number): number {
  return Math.ceil(MAX_LIST_ROWS / pageSize);
}

/** Every policy type `GET /api/v1/policies?type=` accepts (the parameter is required). */
export const POLICY_TYPES: Schemas["PolicyType"][] = [
  "OKTA_SIGN_ON",
  "ACCESS_POLICY",
  "PASSWORD",
  "MFA_ENROLL",
  "PROFILE_ENROLLMENT",
  "IDP_DISCOVERY",
  "POST_AUTH_SESSION",
  "ENTITY_RISK",
  "DEVICE_SIGNAL_COLLECTION",
  "SESSION_VIOLATION_DETECTION",
  "CLIENT_UPDATE",
  "IDENTITY_CLAIM_SOURCING",
];

/** Commonly used event-hook-eligible event types (Okta's Event Types catalog). */
export const EVENT_HOOK_TYPES = [
  "user.lifecycle.create",
  "user.lifecycle.activate",
  "user.lifecycle.deactivate",
  "user.lifecycle.suspend",
  "user.lifecycle.unsuspend",
  "user.lifecycle.delete.initiated",
  "user.account.lock",
  "user.account.unlock",
  "user.account.update_profile",
  "user.account.update_password",
  "user.account.reset_password",
  "user.session.start",
  "user.session.end",
  "user.authentication.sso",
  "user.mfa.factor.activate",
  "user.mfa.factor.deactivate",
  "group.lifecycle.create",
  "group.lifecycle.delete",
  "group.user_membership.add",
  "group.user_membership.remove",
  "application.lifecycle.create",
  "application.lifecycle.activate",
  "application.lifecycle.deactivate",
  "application.lifecycle.delete",
  "application.user_membership.add",
  "application.user_membership.remove",
  "policy.lifecycle.update",
  "system.api_token.create",
  "system.api_token.revoke",
];

function str(value: string | number | boolean | null | undefined): string {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

/** The status on an `apiError`, or on whatever else was thrown. */
function statusOf(error: unknown): number | undefined {
  return error && typeof error === "object" && "status" in error && typeof error.status === "number"
    ? error.status
    : undefined;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** For a list a picker or detail view can do without: only a refused list still says so. */
function noRows(error: unknown): never[] {
  rethrowIncompleteList(error);
  return [];
}

/** A count from a capped read. One that failed shows nothing, because 0 reads as an answer. */
async function countStat(
  label: string,
  rows: Promise<readonly object[]>,
  cap: number,
): Promise<DashboardStat[]> {
  try {
    const { length } = await rows;
    return [{ label, value: length >= cap ? `${cap}+` : String(length) }];
  } catch (error) {
    return noRows(error);
  }
}

/**
 * A field a form may have left out, for spreading into a body: JSON has no `undefined`,
 * so a missing value sends no key, and Okta's own validation error is the better message.
 */
function given<K extends string>(key: K, value: string | undefined): { [P in K]?: string } {
  const out: { [P in K]?: string } = {};
  if (value !== undefined) out[key] = value;
  return out;
}

function bool(value: string | undefined): boolean | undefined {
  if (value === undefined || value === "") return undefined;
  return value === "true" || value === "1" || value === "yes";
}

function list(value: string | undefined): string[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed.map(String).filter(Boolean);
  } catch {
    // comma list
  }
  return value
    .split(/[,\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function addresses(value: string | undefined): Schemas["NetworkZoneAddress"][] {
  return list(value).map((entry) => ({
    type: entry.includes("-") ? "RANGE" : "CIDR",
    value: entry,
  }));
}

/**
 * Turn one scope type on or off and leave the rest as Okta returned them: PUT replaces
 * the origin, and an IFRAME_EMBED scope's `allowedOktaApps` says what may be embedded.
 */
function withScope(
  scopes: Schemas["TrustedOriginScope"][],
  type: string,
  on: boolean | undefined,
): Schemas["TrustedOriginScope"][] {
  if (on === undefined) return scopes;
  if (!on) return scopes.filter((scope) => scope.type !== type);
  return scopes.some((scope) => scope.type === type) ? scopes : [...scopes, { type }];
}

/**
 * A hook's filter as it goes back on a replace, or nothing if it has none left: an entry
 * for an event the hook no longer subscribes to goes with it, and a condition's `version`
 * is read-only.
 */
function eventFilterFor(
  filter: Schemas["EventHookFilters"] | undefined,
  items: string[],
): Schemas["EventHookFilters"] | undefined {
  const entries = (filter?.eventFilterMap ?? [])
    .filter((entry) => entry.event !== undefined && items.includes(entry.event))
    .map(({ condition, ...entry }) => {
      if (!condition) return entry;
      const { version: _readOnly, ...written } = condition;
      return { ...entry, condition: written };
    });
  return entries.length > 0 ? { ...filter, eventFilterMap: entries } : undefined;
}

/** Signing settings without the fields the document marks read-only. */
function writableCredentials(
  credentials: Schemas["AuthorizationServerCredentials"],
): Schemas["AuthorizationServerCredentials"] {
  if (!credentials.signing) return credentials;
  const { kid: _kid, lastRotated: _last, nextRotation: _next, ...signing } = credentials.signing;
  return { ...credentials, signing };
}

type GroupStats = NonNullable<NonNullable<Schemas["Group"]["_embedded"]>["stats"]>;

type ZoneItem = string | Schemas["NetworkZoneLocation"];

/** An array on a DYNAMIC zone, `{ include, exclude }` on DYNAMIC_V2. */
function zoneList(
  value: ZoneItem[] | { include?: ZoneItem[] | null } | null | undefined,
  key: "locations" | "asns",
): string {
  if (!value) return "";
  const items = Array.isArray(value) ? value : (value.include ?? []);
  return items
    .map((item) => {
      if (typeof item === "string") return item;
      if (key === "locations" && item && typeof item === "object") {
        return item.region ? `${str(item.country)}-${str(item.region)}` : str(item.country);
      }
      return "";
    })
    .filter(Boolean)
    .join(", ");
}

export class OktaClient implements PluginClient {
  readonly api: OktaApi;
  private orgCache: Promise<Schemas["OrgSetting"]> | null = null;
  private readonly seatPriceMonthly: string | undefined;

  constructor(credentials: Credentials, services?: HostServices) {
    this.api = new OktaApi(readCredentials(credentials), services);
    this.seatPriceMonthly = credentials["seatPriceMonthly"];
  }

  private org(): Promise<Schemas["OrgSetting"]> {
    this.orgCache ??= this.api.rest.get("/api/v1/org");
    this.orgCache.catch(() => {
      this.orgCache = null;
    });
    return this.orgCache;
  }

  // -------------------------------------------------------------------------
  // Listing
  // -------------------------------------------------------------------------

  listResources(typeId: string, accountId: string): PluginEffect<ResourceInstance[]> {
    return attempt(async () => {
      switch (typeId) {
        case "org":
          return [this.mapOrg(accountId, await this.org())];
        case "user":
          return (
            await this.api.list.getAll("/api/v1/users", null, {
              query: { limit: 200 },
              maxPages: pagesFor(200),
            })
          ).map((u) => this.mapUser(accountId, u));
        case "group":
          // The document allows 10,000 a page, and advises against the maximum.
          return (
            await this.api.list.getAll("/api/v1/groups", null, {
              query: { limit: 1000, expand: "stats" },
              maxPages: pagesFor(1000),
            })
          ).map((g) => this.mapGroup(accountId, g));
        case "app":
          return (
            await this.api.list.getAll("/api/v1/apps", null, {
              query: { limit: 200 },
              maxPages: pagesFor(200),
            })
          ).map((a) => this.mapApp(accountId, a));
        case "authorization-server":
          return (
            await this.api.list.getAll("/api/v1/authorizationServers", null, {
              query: { limit: 200 },
              maxPages: pagesFor(200),
            })
          ).map((s) => this.mapAuthServer(accountId, s));
        case "policy": {
          const settled = await Promise.allSettled(
            POLICY_TYPES.map((type) =>
              this.api.list.getAll("/api/v1/policies", null, { query: { type } }),
            ),
          );
          const answered = settled.some((result) => result.status === "fulfilled");
          return settled.flatMap((result) => {
            if (result.status === "fulfilled")
              return result.value.map((p) => this.mapPolicy(accountId, p));
            // A type the org has no feature for refuses, and has no policies. Anything
            // else, or every type refusing, says nothing about what the org has, and an
            // empty answer would prune them.
            const status = statusOf(result.reason);
            if (answered && (status === 400 || status === 403 || status === 404)) return [];
            throw result.reason;
          });
        }
        case "network-zone":
          return (await this.api.list.getAll("/api/v1/zones", null)).map((z) =>
            this.mapZone(accountId, z),
          );
        case "api-token":
          return (await this.api.list.getAll("/api/v1/api-tokens", null)).map((t) =>
            this.mapApiToken(accountId, t),
          );
        case "event-hook":
          return (await this.api.list.getAll("/api/v1/eventHooks", null)).map((h) =>
            this.mapEventHook(accountId, h),
          );
        case "domain":
          return (await this.api.list.getAll("/api/v1/domains", "domains")).map((d) =>
            this.mapDomain(accountId, d),
          );
        case "trusted-origin":
          return (
            await this.api.list.getAll("/api/v1/trustedOrigins", null, {
              query: { limit: 200 },
              maxPages: pagesFor(200),
            })
          ).map((t) => this.mapTrustedOrigin(accountId, t));
        default:
          throw new Error(`Okta plugin: unknown resource type "${typeId}"`);
      }
    });
  }

  getResource(
    typeId: string,
    resourceId: string,
    accountId: string,
  ): PluginEffect<ResourceInstance> {
    return attempt(async () => {
      const id = pathEncode(externalIdOf(resourceId));
      switch (typeId) {
        case "org":
          this.orgCache = null;
          return this.mapOrg(accountId, await this.org());
        case "user":
          return this.mapUser(accountId, await this.api.rest.get(`/api/v1/users/${id}`));
        case "group":
          return this.mapGroup(accountId, await this.groupWithStats(resourceId));
        case "app":
          return this.mapApp(accountId, await this.api.rest.get(`/api/v1/apps/${id}`));
        case "authorization-server":
          return this.mapAuthServer(
            accountId,
            await this.api.rest.get(`/api/v1/authorizationServers/${id}`),
          );
        case "policy":
          return this.mapPolicy(accountId, await this.api.rest.get(`/api/v1/policies/${id}`));
        case "network-zone":
          return this.mapZone(accountId, await this.api.rest.get(`/api/v1/zones/${id}`));
        case "api-token":
          return this.mapApiToken(accountId, await this.api.rest.get(`/api/v1/api-tokens/${id}`));
        case "event-hook":
          return this.mapEventHook(accountId, await this.api.rest.get(`/api/v1/eventHooks/${id}`));
        case "domain":
          return this.mapDomain(accountId, await this.api.rest.get(`/api/v1/domains/${id}`));
        case "trusted-origin":
          return this.mapTrustedOrigin(
            accountId,
            await this.api.rest.get(`/api/v1/trustedOrigins/${id}`),
          );
        default:
          throw new Error(`Okta plugin: unknown resource type "${typeId}"`);
      }
    });
  }

  /**
   * `expand=stats` is documented on the group list only, and there `filter` takes `id`.
   * A group whose counts cannot be read is still the group, without them.
   */
  private async groupStats(resourceId: string): Promise<GroupStats | undefined> {
    const id = externalIdOf(resourceId);
    if (!/^[\w-]+$/.test(id)) return undefined;
    try {
      const rows = await this.api.rest.get("/api/v1/groups", {
        query: { filter: `id eq "${id}"`, expand: "stats", limit: 1 },
      });
      return rows.find((g) => g.id === id)?._embedded?.stats;
    } catch {
      return undefined;
    }
  }

  private async groupWithStats(resourceId: string): Promise<Schemas["Group"]> {
    const [group, stats] = await Promise.all([
      this.api.rest.get(`/api/v1/groups/${pathEncode(externalIdOf(resourceId))}`),
      this.groupStats(resourceId),
    ]);
    return stats ? { ...group, _embedded: { ...group._embedded, stats } } : group;
  }

  resolveOutput(
    typeId: string,
    resourceId: string,
    outputKey: string,
    accountId: string,
  ): PluginEffect<string> {
    return attempt(async () => {
      const resource = await runPluginEffect(this.getResource(typeId, resourceId, accountId));
      const value = resource.resolvedOutputs[outputKey];
      if (value !== undefined && value !== "") return value;
      throw new Error(`Okta plugin: cannot resolve output "${outputKey}" for type "${typeId}"`);
    });
  }

  // -------------------------------------------------------------------------
  // Mapping
  // -------------------------------------------------------------------------

  private instance(
    accountId: string,
    typeId: string,
    externalId: string,
    displayName: string,
    fields: ResourceInstance["fields"],
    outputs: Record<string, string>,
    createdAt?: string,
    updatedAt?: string,
  ): ResourceInstance {
    const created = createdAt || new Date(0).toISOString();
    return {
      id: `${accountId}:${typeId}:${externalId}`,
      pluginId: PLUGIN_ID,
      resourceTypeId: typeId,
      accountId,
      displayName: displayName || externalId,
      externalId,
      fields,
      resolvedOutputs: outputs,
      secretStates: [],
      createdAt: created,
      updatedAt: updatedAt || created,
    };
  }

  mapOrg(accountId: string, org: Schemas["OrgSetting"]): ResourceInstance {
    const id = str(org.id) || "org";
    return this.instance(
      accountId,
      "org",
      id,
      str(org.companyName) || str(org.subdomain),
      {
        companyName: str(org.companyName),
        subdomain: str(org.subdomain),
        orgUrl: this.api.orgUrl,
        website: str(org.website),
        phoneNumber: str(org.phoneNumber),
        supportPhoneNumber: str(org.supportPhoneNumber),
        endUserSupportHelpURL: str(org.endUserSupportHelpURL),
        address1: str(org.address1),
        city: str(org.city),
        state: str(org.state),
        postalCode: str(org.postalCode),
        country: str(org.country),
        status: str(org.status),
        created: str(org.created),
      },
      { orgUrl: this.api.orgUrl, orgId: id },
      org.created,
      org.lastUpdated,
    );
  }

  mapUser(accountId: string, u: Schemas["User"]): ResourceInstance {
    const p = u.profile ?? {};
    const name = [str(p.firstName), str(p.lastName)].filter(Boolean).join(" ");
    return this.instance(
      accountId,
      "user",
      str(u.id),
      str(p.login) || name,
      {
        login: str(p.login),
        email: str(p.email),
        firstName: str(p.firstName),
        lastName: str(p.lastName),
        displayName: str(p.displayName),
        title: str(p.title),
        department: str(p.department),
        mobilePhone: str(p.mobilePhone),
        status: str(u.status),
        userId: str(u.id),
        lastLogin: str(u.lastLogin),
        passwordChanged: str(u.passwordChanged),
        statusChanged: str(u.statusChanged),
        created: str(u.created),
      },
      { userId: str(u.id), login: str(p.login) },
      u.created,
      u.lastUpdated,
    );
  }

  mapGroup(accountId: string, g: Schemas["Group"]): ResourceInstance {
    const stats = g._embedded?.stats;
    return this.instance(
      accountId,
      "group",
      str(g.id),
      str(g.profile?.name),
      {
        name: str(g.profile?.name),
        description: str(g.profile?.description),
        type: str(g.type),
        ...(typeof stats?.usersCount === "number" ? { memberCount: stats.usersCount } : {}),
        ...(typeof stats?.appsCount === "number" ? { appCount: stats.appsCount } : {}),
        lastMembershipUpdated: str(g.lastMembershipUpdated),
        created: str(g.created),
      },
      { groupId: str(g.id) },
      g.created,
      g.lastUpdated,
    );
  }

  mapApp(accountId: string, a: Schemas["Application"]): ResourceInstance {
    const clientId = str(a.credentials?.oauthClient?.client_id);
    const metadataUrl = a.signOnMode === "SAML_2_0" ? str(a._links?.metadata?.href) : "";
    return this.instance(
      accountId,
      "app",
      str(a.id),
      str(a.label) || str(a.name),
      {
        label: str(a.label),
        name: str(a.name),
        signOnMode: str(a.signOnMode),
        status: str(a.status),
        clientId,
        features: (a.features ?? []).join(", "),
        created: str(a.created),
        lastUpdated: str(a.lastUpdated),
      },
      { appId: str(a.id), clientId, metadataUrl },
      a.created,
      a.lastUpdated,
    );
  }

  mapAuthServer(accountId: string, s: Schemas["AuthorizationServer"]): ResourceInstance {
    const issuer = str(s.issuer);
    return this.instance(
      accountId,
      "authorization-server",
      str(s.id),
      str(s.name),
      {
        name: str(s.name),
        description: str(s.description),
        audiences: (s.audiences ?? []).join(", "),
        issuer,
        issuerMode: str(s.issuerMode),
        status: str(s.status),
        rotationMode: str(s.credentials?.signing?.rotationMode),
        nextKeyRotation: str(s.credentials?.signing?.nextRotation),
        created: str(s.created),
      },
      {
        issuer,
        authServerId: str(s.id),
        metadataUrl: issuer ? `${issuer}/.well-known/oauth-authorization-server` : "",
      },
      s.created,
      s.lastUpdated,
    );
  }

  mapPolicy(accountId: string, p: Schemas["Policy"]): ResourceInstance {
    return this.instance(
      accountId,
      "policy",
      str(p.id),
      str(p.name),
      {
        name: str(p.name),
        description: str(p.description),
        type: str(p.type),
        status: str(p.status),
        ...(typeof p.priority === "number" ? { priority: p.priority } : {}),
        system: p.system === true,
        created: str(p.created),
        lastUpdated: str(p.lastUpdated),
      },
      { policyId: str(p.id) },
      p.created,
      p.lastUpdated,
    );
  }

  mapZone(accountId: string, z: Schemas["NetworkZone"]): ResourceInstance {
    return this.instance(
      accountId,
      "network-zone",
      str(z.id),
      str(z.name),
      {
        name: str(z.name),
        type: str(z.type),
        usage: str(z.usage),
        status: str(z.status),
        gateways: (z.gateways ?? []).map((g) => str(g.value)).join(", "),
        proxies: (z.proxies ?? []).map((g) => str(g.value)).join(", "),
        locations: zoneList(z.locations, "locations"),
        asns: zoneList(z.asns, "asns"),
        system: z.system === true,
        created: str(z.created),
      },
      { zoneId: str(z.id) },
      z.created,
      z.lastUpdated,
    );
  }

  mapApiToken(accountId: string, t: Schemas["ApiToken"]): ResourceInstance {
    const network = t.network?.connection
      ? [t.network.connection, ...(t.network.include ?? [])].filter(Boolean).join(": ")
      : "";
    return this.instance(
      accountId,
      "api-token",
      str(t.id),
      str(t.name),
      {
        name: str(t.name),
        userId: str(t.userId),
        clientName: str(t.clientName),
        network,
        tokenWindow: str(t.tokenWindow),
        created: str(t.created),
        expiresAt: str(t.expiresAt),
      },
      {},
      t.created,
      t.lastUpdated,
    );
  }

  mapEventHook(accountId: string, h: Schemas["EventHook"]): ResourceInstance {
    const config = h.channel?.config;
    return this.instance(
      accountId,
      "event-hook",
      str(h.id),
      str(h.name),
      {
        name: str(h.name),
        uri: str(config?.uri),
        events: (h.events?.items ?? []).join(", "),
        status: str(h.status),
        verificationStatus: str(h.verificationStatus),
        authHeaderName: str(config?.authScheme?.key),
        description: str(h.description),
        created: str(h.created),
      },
      { eventHookId: str(h.id) },
      h.created,
      h.lastUpdated,
    );
  }

  mapDomain(accountId: string, d: Schemas["DomainResponse"]): ResourceInstance {
    const cname = (d.dnsRecords ?? []).find((r) => r.recordType === "CNAME");
    return this.instance(
      accountId,
      "domain",
      str(d.id),
      str(d.domain),
      {
        domain: str(d.domain),
        validationStatus: str(d.validationStatus),
        certificateSourceType: str(d.certificateSourceType),
        certificateExpiration: str(d.publicCertificate?.expiration),
        certificateSubject: str(d.publicCertificate?.subject),
        cnameTarget: str(cname?.values?.[0]),
        brandId: str(d.brandId),
      },
      { domain: str(d.domain), __dnsRecords__: JSON.stringify(d.dnsRecords ?? []) },
    );
  }

  mapTrustedOrigin(accountId: string, t: Schemas["TrustedOrigin"]): ResourceInstance {
    const scopes = new Set((t.scopes ?? []).map((s) => str(s.type)));
    return this.instance(
      accountId,
      "trusted-origin",
      str(t.id),
      str(t.name) || str(t.origin),
      {
        name: str(t.name),
        origin: str(t.origin),
        cors: scopes.has("CORS"),
        redirect: scopes.has("REDIRECT"),
        iframeEmbed: scopes.has("IFRAME_EMBED"),
        status: str(t.status),
        created: str(t.created),
      },
      { origin: str(t.origin) },
      t.created,
      t.lastUpdated,
    );
  }

  // -------------------------------------------------------------------------
  // Preflight
  // -------------------------------------------------------------------------

  verifyCredentials(): PluginEffect<PreflightResult> {
    return attempt(async () => {
      const checks: PreflightCapabilityCheck[] = [];
      const probe = async <T>(capabilityId: string, scope: string, read: () => Promise<T>) => {
        try {
          await read();
          checks.push({ capabilityId, status: "ok" });
        } catch (error) {
          const status = statusOf(error);
          if (status === 401 || status === 403) {
            checks.push({
              capabilityId,
              status: "missing",
              missingPermissions: [{ id: scope, label: scope }],
              message: messageOf(error),
            });
          } else {
            checks.push({ capabilityId, status: "unknown", message: messageOf(error) });
          }
        }
      };
      let identity = "";
      try {
        const org = await this.org();
        identity = str(org.companyName) || str(org.subdomain);
        checks.push({ capabilityId: "org", status: "ok" });
      } catch (error) {
        const status = statusOf(error);
        checks.push(
          status === 401 || status === 403
            ? {
                capabilityId: "org",
                status: "missing",
                missingPermissions: [{ id: "okta.orgs.read", label: "okta.orgs.read" }],
                message: messageOf(error),
              }
            : { capabilityId: "org", status: "unknown", message: messageOf(error) },
        );
      }
      const query = { limit: 1 };
      const { rest } = this.api;
      await probe("users", "okta.users.read", () => rest.get("/api/v1/users", { query }));
      await probe("groups", "okta.groups.read", () => rest.get("/api/v1/groups", { query }));
      await probe("apps", "okta.apps.read", () => rest.get("/api/v1/apps", { query }));
      await probe("security", "okta.networkZones.read", () => rest.get("/api/v1/zones", { query }));
      await probe("logs", "okta.logs.read", () => rest.get("/api/v1/logs", { query }));
      return { checks, ...(identity ? { identity } : {}) };
    });
  }

  // -------------------------------------------------------------------------
  // Metrics, quotas, logs
  // -------------------------------------------------------------------------

  fetchMetricSeries(
    resourceTypeId: string,
    _resourceId: string,
    _accountId: string,
    timeRange?: { startMs: number; endMs: number },
  ): PluginEffect<MetricSeries[]> {
    return attempt(async () => {
      if (resourceTypeId !== "org") return [];
      const endMs = timeRange?.endMs ?? Date.now();
      const startMs = timeRange?.startMs ?? endMs - METRICS_DEFAULT_RANGE_MS;
      const filter = [
        'eventType eq "user.session.start"',
        'eventType eq "user.authentication.sso"',
        'eventType eq "user.account.lock"',
        'eventType sw "system.org.rate_limit"',
        'eventType sw "system.client.rate_limit"',
        'eventType sw "system.operation.rate_limit"',
      ].join(" or ");
      const events = await this.api.list.getAll("/api/v1/logs", null, {
        query: {
          since: new Date(startMs).toISOString(),
          until: new Date(endMs).toISOString(),
          filter,
          limit: 1000,
          sortOrder: "DESCENDING",
        },
        maxPages: MAX_LOG_PAGES,
        partial: true,
      });
      const bucketMs = Math.max(
        60_000,
        Math.ceil((endMs - startMs) / METRIC_BUCKETS / 60_000) * 60_000,
      );
      const buckets: number[] = [];
      for (let at = startMs; at < endMs; at += bucketMs) buckets.push(at);
      const series: Array<{ label: string; match: (e: Schemas["LogEvent"]) => boolean }> = [
        {
          label: "Successful sign-ins",
          match: (e) => e.eventType === "user.session.start" && e.outcome?.result === "SUCCESS",
        },
        {
          label: "Failed sign-ins",
          match: (e) => e.eventType === "user.session.start" && e.outcome?.result === "FAILURE",
        },
        {
          label: "App SSO",
          match: (e) =>
            e.eventType === "user.authentication.sso" && e.outcome?.result === "SUCCESS",
        },
        { label: "Account lockouts", match: (e) => e.eventType === "user.account.lock" },
        {
          label: "Rate limit warnings",
          match: (e) => /rate_limit/.test(str(e.eventType)) && /warning/.test(str(e.eventType)),
        },
        {
          label: "Rate limit violations",
          match: (e) => /rate_limit/.test(str(e.eventType)) && /violation/.test(str(e.eventType)),
        },
      ];
      const out: MetricSeries[] = series.map(({ label, match }) => {
        const counts = new Map<number, number>(buckets.map((at) => [at, 0]));
        for (const event of events) {
          const at = Date.parse(str(event.published));
          if (!Number.isFinite(at) || !match(event)) continue;
          const bucket = startMs + Math.floor((at - startMs) / bucketMs) * bucketMs;
          const current = counts.get(bucket);
          if (current !== undefined) counts.set(bucket, current + 1);
        }
        return {
          label,
          unit: "count",
          points: buckets.map((timestamp) => ({ timestamp, value: counts.get(timestamp) ?? 0 })),
        };
      });
      // The System Log call above returned this minute's headroom on the logs endpoint.
      for (const reading of this.api.rateLimits.values()) {
        out.push({
          label: `Rate limit remaining: ${reading.bucket}`,
          unit: "percent",
          points: [
            {
              timestamp: Date.now(),
              value: Math.round((reading.remaining / reading.limit) * 1000) / 10,
            },
          ],
        });
      }
      return out;
    });
  }

  /**
   * Okta has no API that reports rate-limit usage; each response carries the
   * per-minute `X-Rate-Limit-Limit`/`-Remaining` for its endpoint family, so
   * this probes a fixed set of the busiest families with `limit=1` reads and
   * reports what Okta said. Both halves come from the provider.
   */
  fetchQuotas(_accountId: string): PluginEffect<QuotaUsage[]> {
    return attempt(async () => {
      const query = { limit: 1 };
      const { rest } = this.api;
      const probes: Array<[string, string, () => Promise<ApiAnswer<object>>]> = [
        ["/api/v1/users", "Users API", () => rest.getResponse("/api/v1/users", { query })],
        ["/api/v1/groups", "Groups API", () => rest.getResponse("/api/v1/groups", { query })],
        ["/api/v1/apps", "Apps API", () => rest.getResponse("/api/v1/apps", { query })],
        ["/api/v1/logs", "System Log API", () => rest.getResponse("/api/v1/logs", { query })],
        [
          "/api/v1/authorizationServers",
          "Authorization servers API",
          () => rest.getResponse("/api/v1/authorizationServers", { query }),
        ],
      ];
      const out: QuotaUsage[] = [];
      for (const [path, name, read] of probes) {
        const res = await read();
        const limit = Number(res.headers["x-rate-limit-limit"]);
        const remaining = Number(res.headers["x-rate-limit-remaining"]);
        if (!Number.isFinite(limit) || !Number.isFinite(remaining) || limit <= 0) continue;
        out.push({
          id: `rate-limit:${path}`,
          service: "Okta API",
          name: `${name} requests per minute`,
          limit,
          used: Math.max(0, limit - remaining),
          unit: "requests/min",
          adjustable: true,
          docsUrl: "https://developer.okta.com/docs/reference/rl-global-mgmt/",
        });
      }
      return out;
    });
  }

  fetchDashboardStats(resourceTypeId: string, resourceId: string): PluginEffect<DashboardStat[]> {
    return attempt(async () => {
      const id = pathEncode(externalIdOf(resourceId));
      if (resourceTypeId === "group") {
        const stats = await this.groupStats(resourceId);
        const counts: Array<[string, number | undefined]> = [
          ["Members", stats?.usersCount],
          ["Apps", stats?.appsCount],
        ];
        return counts.flatMap(([label, count]) =>
          count === undefined ? [] : [{ label, value: String(count) }],
        );
      }
      if (resourceTypeId === "app") {
        const [users, groups] = await Promise.all([
          countStat(
            "Assigned users",
            this.api.list.getAll(`/api/v1/apps/${id}/users`, null, {
              query: { limit: 500 },
              maxPages: 4,
              partial: true,
            }),
            2000,
          ),
          countStat(
            "Assigned groups",
            this.api.list.getAll(`/api/v1/apps/${id}/groups`, null, {
              query: { limit: 200 },
              maxPages: 4,
              partial: true,
            }),
            800,
          ),
        ]);
        return [...users, ...groups];
      }
      return [];
    });
  }

  getLogs(
    typeId: string,
    resourceId: string,
    _accountId: string,
    params: LogsFetchParams,
  ): PluginEffect<LogsFetchResult> {
    return attempt(async () => {
      const id = externalIdOf(resourceId);
      const limit = Math.min(Math.max(params.tailLines ?? 100, 1), 1000);
      let filter = "";
      if (typeId === "user") filter = `actor.id eq "${id}" or target.id eq "${id}"`;
      else if (
        typeId === "group" ||
        typeId === "app" ||
        typeId === "policy" ||
        typeId === "authorization-server"
      ) {
        filter = `target.id eq "${id}"`;
      } else if (typeId !== "org") {
        throw new Error(
          "Okta plugin: the System Log is shown on the org, users, groups, apps, policies and authorization servers",
        );
      }
      const events = await this.api.rest.get("/api/v1/logs", {
        query: {
          limit,
          sortOrder: "DESCENDING",
          since: new Date(Date.now() - 7 * 86_400_000).toISOString(),
          ...(filter ? { filter } : {}),
        },
      });
      const lines = (events ?? [])
        .slice()
        .reverse()
        .map((e) => {
          const actor = str(e.actor?.alternateId) || str(e.actor?.displayName);
          const target = (e.target ?? [])
            .map((t) => str(t.displayName) || str(t.alternateId))
            .filter(Boolean)
            .join(", ");
          return [
            str(e.published),
            str(e.severity),
            str(e.eventType),
            str(e.outcome?.result),
            str(e.displayMessage),
            actor ? `actor=${actor}` : "",
            target ? `target=${target}` : "",
            e.client?.ipAddress ? `ip=${e.client.ipAddress}` : "",
            e.outcome?.reason ? `reason="${e.outcome.reason}"` : "",
          ]
            .filter(Boolean)
            .join(" ");
        });
      return {
        text: lines.map((l) => `${l}\n`).join(""),
        containers: ["system-log"],
        activeContainer: "system-log",
      };
    });
  }

  // -------------------------------------------------------------------------
  // Create
  // -------------------------------------------------------------------------

  private async groupOptions(oktaOnly = true): Promise<SelectOption[]> {
    const groups = await this.api.list
      .getAll("/api/v1/groups", null, { query: { limit: 1000 }, maxPages: 5, partial: true })
      .catch(noRows);
    return groups
      .filter((g) => !oktaOnly || g.type === "OKTA_GROUP")
      .map((g) => ({
        id: str(g.id),
        label: str(g.profile?.name),
        ...(g.profile?.description ? { description: str(g.profile.description) } : {}),
      }));
  }

  private async userOptions(): Promise<SelectOption[]> {
    const users = await this.api.list
      .getAll("/api/v1/users", null, {
        query: { limit: 200, filter: 'status eq "ACTIVE"' },
        maxPages: 5,
        partial: true,
      })
      .catch(noRows);
    return users.map((u) => ({ id: str(u.id), label: str(u.profile?.login) }));
  }

  getCreateConfig(typeId: string): PluginEffect<CreateResourceConfig> {
    return attempt(async () => {
      switch (typeId) {
        case "user": {
          const groups = await this.groupOptions();
          return {
            fields: [
              { key: "firstName", label: "First name", kind: "text", required: true },
              { key: "lastName", label: "Last name", kind: "text", required: true },
              {
                key: "email",
                label: "Email",
                kind: "text",
                required: true,
                placeholder: "ada@example.com",
              },
              {
                key: "login",
                label: "Login",
                kind: "text",
                required: false,
                description: "Defaults to the email address.",
              },
              {
                key: "activation",
                label: "Activation",
                kind: "select",
                required: true,
                defaultValue: "email",
                options: [
                  { id: "email", label: "Activate and email an activation link" },
                  { id: "password", label: "Activate with a password I set" },
                  { id: "staged", label: "Create as staged (do not activate)" },
                ],
              },
              {
                key: "password",
                label: "Password",
                kind: "password",
                required: false,
                showWhen: { fieldKey: "activation", fieldValue: "password" },
              },
              {
                key: "changePassword",
                label: "Require a new password at first sign-in",
                kind: "select",
                required: false,
                defaultValue: "true",
                options: [
                  { id: "true", label: "Yes" },
                  { id: "false", label: "No" },
                ],
                showWhen: { fieldKey: "activation", fieldValue: "password" },
              },
              ...(groups.length > 0
                ? [
                    {
                      key: "groupIds",
                      label: "Groups",
                      kind: "policy-picker" as const,
                      required: false,
                      policies: groups.map((g) => ({
                        id: g.id,
                        label: g.label,
                        category: "Okta groups",
                      })),
                    },
                  ]
                : []),
            ],
          };
        }
        case "group":
          return {
            fields: [
              { key: "name", label: "Name", kind: "text", required: true },
              { key: "description", label: "Description", kind: "text", required: false },
            ],
          };
        case "authorization-server":
          return {
            fields: [
              { key: "name", label: "Name", kind: "text", required: true },
              {
                key: "audiences",
                label: "Audience",
                kind: "text",
                required: true,
                placeholder: "api://default",
              },
              { key: "description", label: "Description", kind: "text", required: false },
            ],
          };
        case "network-zone":
          return {
            fields: [
              { key: "name", label: "Name", kind: "text", required: true },
              {
                key: "usage",
                label: "Usage",
                kind: "select",
                required: true,
                defaultValue: "POLICY",
                options: [
                  { id: "POLICY", label: "Policy zone (use in sign-on and app policies)" },
                  { id: "BLOCKLIST", label: "Blocklist (deny all requests from these IPs)" },
                ],
              },
              {
                key: "gateways",
                label: "Gateway IPs",
                kind: "string-list",
                required: true,
                addLabel: "+ Add CIDR or range",
                description: "CIDR (203.0.113.0/24) or range (203.0.113.1-203.0.113.9).",
              },
              {
                key: "proxies",
                label: "Trusted proxies",
                kind: "string-list",
                required: false,
                addLabel: "+ Add proxy",
                showWhen: { fieldKey: "usage", fieldValue: "POLICY" },
              },
            ],
          };
        case "event-hook":
          return {
            fields: [
              { key: "name", label: "Name", kind: "text", required: true },
              {
                key: "uri",
                label: "Endpoint URL",
                kind: "text",
                required: true,
                placeholder: "https://hooks.example.com/okta",
              },
              {
                key: "events",
                label: "Events",
                kind: "policy-picker",
                required: false,
                policies: this.eventOptions(),
              },
              {
                key: "otherEvents",
                label: "Other event types",
                kind: "string-list",
                required: false,
                addLabel: "+ Add event type",
                description: "Any other event-hook-eligible type from Okta's Event Types catalog.",
              },
              {
                key: "authHeaderName",
                label: "Auth header name",
                kind: "text",
                required: false,
                defaultValue: "Authorization",
              },
              {
                key: "authHeaderValue",
                label: "Auth header value",
                kind: "password",
                required: false,
                description: "Sent with every delivery so your endpoint can reject other callers.",
              },
            ],
          };
        case "domain":
          return {
            fields: [
              {
                key: "domain",
                label: "Domain",
                kind: "text",
                required: true,
                placeholder: "login.example.com",
              },
              {
                key: "certificateSourceType",
                label: "Certificate",
                kind: "select",
                required: true,
                defaultValue: "OKTA_MANAGED",
                options: [
                  { id: "OKTA_MANAGED", label: "Okta-managed (Okta provisions and renews it)" },
                  { id: "MANUAL", label: "Bring my own certificate" },
                ],
              },
            ],
          };
        case "trusted-origin":
          return {
            fields: [
              { key: "name", label: "Name", kind: "text", required: true },
              {
                key: "origin",
                label: "Origin",
                kind: "text",
                required: true,
                placeholder: "https://app.example.com",
              },
              {
                key: "scopes",
                label: "Allow",
                kind: "policy-picker",
                required: true,
                policies: [
                  {
                    id: "CORS",
                    label: "CORS",
                    description: "Browser calls to Okta APIs from this origin.",
                  },
                  {
                    id: "REDIRECT",
                    label: "Redirect",
                    description: "Redirects back to this origin after sign-in.",
                  },
                  {
                    id: "IFRAME_EMBED",
                    label: "Iframe embed",
                    description: "Embed the Okta sign-in page in an iframe.",
                  },
                ],
              },
            ],
          };
        default:
          throw new Error(`Okta plugin: cannot create resource type "${typeId}"`);
      }
    });
  }

  private eventOptions(): PolicyOption[] {
    return EVENT_HOOK_TYPES.map((type) => ({
      id: type,
      label: type,
      category: type.split(".")[0] ?? type,
    }));
  }

  createResource(
    typeId: string,
    accountId: string,
    fields: Record<string, string>,
  ): PluginEffect<ResourceInstance> {
    return attempt(async () => {
      switch (typeId) {
        case "user": {
          const activation = fields["activation"] || "email";
          const email = (fields["email"] ?? "").trim();
          const groupIds = list(fields["groupIds"]);
          const user = await this.api.rest.post("/api/v1/users", {
            query: {
              activate: activation !== "staged",
              ...(activation === "password" && fields["changePassword"] !== "false"
                ? { nextLogin: "changePassword" }
                : {}),
            },
            body: {
              profile: {
                ...given("firstName", fields["firstName"]),
                ...given("lastName", fields["lastName"]),
                email,
                login: (fields["login"] ?? "").trim() || email,
              },
              ...(groupIds.length > 0 ? { groupIds } : {}),
              ...(activation === "password" && fields["password"]
                ? { credentials: { password: { value: fields["password"] } } }
                : {}),
            },
          });
          return this.mapUser(accountId, user);
        }
        case "group": {
          const group = await this.api.rest.post("/api/v1/groups", {
            body: {
              profile: {
                ...given("name", fields["name"]),
                description: fields["description"] ?? "",
              },
            },
          });
          return this.mapGroup(accountId, group);
        }
        case "authorization-server": {
          const server = await this.api.rest.post("/api/v1/authorizationServers", {
            body: {
              name: fields["name"],
              description: fields["description"] ?? "",
              audiences: list(fields["audiences"]),
            },
          });
          return this.mapAuthServer(accountId, server);
        }
        case "network-zone": {
          const usage = fields["usage"] || "POLICY";
          const zone = await this.api.rest.post("/api/v1/zones", {
            body: {
              type: "IP",
              name: fields["name"],
              usage,
              gateways: addresses(fields["gateways"]),
              ...(usage === "POLICY" && fields["proxies"]
                ? { proxies: addresses(fields["proxies"]) }
                : {}),
            },
          });
          return this.mapZone(accountId, zone);
        }
        case "event-hook": {
          const events = [...list(fields["events"]), ...list(fields["otherEvents"])];
          if (events.length === 0) throw new Error("Okta plugin: choose at least one event type");
          const hook = await this.api.rest.post("/api/v1/eventHooks", {
            body: {
              name: fields["name"],
              events: { type: "EVENT_TYPE", items: events },
              channel: {
                type: "HTTP",
                version: "1.0.0",
                config: {
                  ...given("uri", fields["uri"]),
                  ...(fields["authHeaderValue"]
                    ? {
                        authScheme: {
                          type: "HEADER",
                          key: fields["authHeaderName"] || "Authorization",
                          value: fields["authHeaderValue"],
                        },
                      }
                    : {}),
                },
              },
            },
          });
          return this.mapEventHook(accountId, hook);
        }
        case "domain": {
          const domain = await this.api.rest.post("/api/v1/domains", {
            body: {
              domain: fields["domain"],
              certificateSourceType: fields["certificateSourceType"] || "OKTA_MANAGED",
            },
          });
          return this.mapDomain(accountId, domain);
        }
        case "trusted-origin": {
          const scopes = list(fields["scopes"]);
          const origin = await this.api.rest.post("/api/v1/trustedOrigins", {
            body: {
              name: fields["name"],
              origin: fields["origin"],
              scopes: (scopes.length > 0 ? scopes : ["CORS"]).map((type) => ({ type })),
            },
          });
          return this.mapTrustedOrigin(accountId, origin);
        }
        default:
          throw new Error(`Okta plugin: cannot create resource type "${typeId}"`);
      }
    });
  }

  // -------------------------------------------------------------------------
  // Update
  // -------------------------------------------------------------------------

  updateResource(
    typeId: string,
    resourceId: string,
    accountId: string,
    fields: Record<string, string>,
  ): PluginEffect<ResourceInstance> {
    return attempt(async () => {
      const id = pathEncode(externalIdOf(resourceId));
      switch (typeId) {
        case "org": {
          this.orgCache = null;
          return this.mapOrg(
            accountId,
            // POST /api/v1/org is a partial update; PUT would replace every field.
            await this.api.rest.post("/api/v1/org", {
              body: {
                ...given("companyName", fields["companyName"]),
                ...given("website", fields["website"]),
                ...given("phoneNumber", fields["phoneNumber"]),
                ...given("supportPhoneNumber", fields["supportPhoneNumber"]),
                ...given("endUserSupportHelpURL", fields["endUserSupportHelpURL"]),
                ...given("address1", fields["address1"]),
                ...given("city", fields["city"]),
                ...given("state", fields["state"]),
                ...given("postalCode", fields["postalCode"]),
                ...given("country", fields["country"]),
              },
            }),
          );
        }
        case "user": {
          return this.mapUser(
            accountId,
            // POST /api/v1/users/{id} is a partial profile update.
            await this.api.rest.post(`/api/v1/users/${id}`, {
              body: {
                profile: {
                  ...given("login", fields["login"]),
                  ...given("email", fields["email"]),
                  ...given("firstName", fields["firstName"]),
                  ...given("lastName", fields["lastName"]),
                  ...given("displayName", fields["displayName"]),
                  ...given("title", fields["title"]),
                  ...given("department", fields["department"]),
                  ...given("mobilePhone", fields["mobilePhone"]),
                },
              },
            }),
          );
        }
        case "group": {
          const current = await this.api.rest.get(`/api/v1/groups/${id}`);
          if (current.type !== "OKTA_GROUP") {
            throw Object.assign(new Error("Okta plugin: only Okta-mastered groups can be edited"), {
              status: 400,
            });
          }
          await this.api.rest.put(`/api/v1/groups/${id}`, {
            body: {
              profile: {
                ...given("name", fields["name"] ?? current.profile?.name),
                description: fields["description"] ?? current.profile?.description ?? "",
              },
            },
          });
          return runPluginEffect(this.getResource(typeId, resourceId, accountId));
        }
        case "app": {
          // Apps only support full replacement: read, change, write back.
          const current = await this.api.rest.get(`/api/v1/apps/${id}`);
          if (fields["label"] !== undefined) current.label = fields["label"];
          return this.mapApp(
            accountId,
            await this.api.rest.put(`/api/v1/apps/${id}`, { body: current }),
          );
        }
        case "authorization-server": {
          const current = await this.api.rest.get(`/api/v1/authorizationServers/${id}`);
          // A replace: rotation mode and token encryption go back as they were read. Okta
          // works `issuer` out from `issuerMode`, so the one read would fight a new mode.
          const {
            _links: _notSentBack,
            id: _id,
            created: _created,
            lastUpdated: _lastUpdated,
            issuer: _issuer,
            credentials,
            ...kept
          } = current;
          return this.mapAuthServer(
            accountId,
            await this.api.rest.put(`/api/v1/authorizationServers/${id}`, {
              body: {
                ...kept,
                ...(credentials ? { credentials: writableCredentials(credentials) } : {}),
                name: fields["name"] ?? current.name,
                description: fields["description"] ?? current.description ?? "",
                audiences:
                  fields["audiences"] !== undefined ? list(fields["audiences"]) : current.audiences,
                ...(fields["issuerMode"] ? { issuerMode: fields["issuerMode"] } : {}),
              },
            }),
          );
        }
        case "policy": {
          const current = await this.api.rest.get(`/api/v1/policies/${id}`);
          const { _links: _notSentBack, ...kept } = { ...current };
          return this.mapPolicy(
            accountId,
            await this.api.rest.put(`/api/v1/policies/${id}`, {
              body: {
                ...kept,
                ...given("name", fields["name"]),
                ...given("description", fields["description"]),
                ...(fields["priority"] ? { priority: Number(fields["priority"]) } : {}),
              },
            }),
          );
        }
        case "network-zone": {
          const current = await this.api.rest.get(`/api/v1/zones/${id}`);
          const { _links: _notSentBack, ...kept } = { ...current };
          const isIp = current.type === "IP";
          return this.mapZone(
            accountId,
            await this.api.rest.put(`/api/v1/zones/${id}`, {
              body: {
                ...kept,
                ...given("name", fields["name"]),
                ...(isIp && fields["gateways"] !== undefined
                  ? { gateways: addresses(fields["gateways"]) }
                  : {}),
                ...(isIp && fields["proxies"] !== undefined
                  ? { proxies: addresses(fields["proxies"]) }
                  : {}),
              },
            }),
          );
        }
        case "event-hook": {
          const current = await this.api.rest.get(`/api/v1/eventHooks/${id}`);
          const config: Partial<Schemas["EventHookChannelConfig"]> = {
            ...(current.channel?.config ?? {}),
          };
          // Okta never returns the auth header value (it is write-only). A new
          // value from the form replaces the scheme; otherwise the scheme goes
          // back exactly as Okta returned it.
          if (fields["authHeaderValue"]) {
            config.authScheme = {
              type: "HEADER",
              key: fields["authHeaderName"] || config.authScheme?.key || "Authorization",
              value: fields["authHeaderValue"],
            };
          }
          const items =
            fields["events"] !== undefined ? list(fields["events"]) : (current.events?.items ?? []);
          const filter = eventFilterFor(current.events?.filter, items);
          return this.mapEventHook(
            accountId,
            await this.api.rest.put(`/api/v1/eventHooks/${id}`, {
              body: {
                name: fields["name"] ?? current.name,
                description: fields["description"] ?? current.description ?? null,
                events: { type: "EVENT_TYPE", items, ...(filter ? { filter } : {}) },
                channel: {
                  type: "HTTP",
                  version: current.channel?.version ?? "1.0.0",
                  config: { ...config, ...given("uri", fields["uri"] ?? config.uri) },
                },
              },
            }),
          );
        }
        case "trusted-origin": {
          const current = await this.api.rest.get(`/api/v1/trustedOrigins/${id}`);
          const scopes = withScope(
            withScope(current.scopes ?? [], "CORS", bool(fields["cors"])),
            "REDIRECT",
            bool(fields["redirect"]),
          );
          return this.mapTrustedOrigin(
            accountId,
            await this.api.rest.put(`/api/v1/trustedOrigins/${id}`, {
              body: {
                name: fields["name"] ?? current.name,
                origin: fields["origin"] ?? current.origin,
                scopes,
              },
            }),
          );
        }
        default:
          throw new Error(`Okta plugin: cannot update resource type "${typeId}"`);
      }
    });
  }

  // -------------------------------------------------------------------------
  // Seats
  // -------------------------------------------------------------------------

  /**
   * Every licensed user, read with `GET /api/v1/users` (200 per page, `after`
   * cursor in the `Link` header; DEPROVISIONED users are omitted by default).
   * https://developer.okta.com/docs/api/openapi/okta-management/management/tag/User/#tag/User/operation/listUsers
   * Every page or nothing: a failed page fails the read. Seats are not resource rows,
   * so the host's prune limit does not bound this one.
   */
  fetchSeats(_accountId: string, _options: SeatFetchOptions): PluginEffect<SeatRecord[]> {
    return attempt(async () => {
      const users = await this.api.list.getAll("/api/v1/users", null, {
        query: { limit: 200 },
        maxPages: 1000,
      });
      const price = oktaSeatPrice(this.seatPriceMonthly);
      const orgUrl = this.api.orgUrl;
      const seats: SeatRecord[] = [];
      for (const user of users) {
        const seat = mapOktaSeat(user, orgUrl, price);
        if (seat) seats.push(seat);
      }
      return seats;
    });
  }

  /**
   * Deactivate the user, which frees the licence. Destructive:
   * Okta deprovisions every app assignment.
   * https://developer.okta.com/docs/api/openapi/okta-management/management/tag/User/#tag/User/operation/deactivateUser
   */
  removeSeat(_accountId: string, seat: SeatRef): PluginEffect<SeatRemovalResult> {
    return attempt(async () => {
      const id = pathEncode(seat.memberId);
      const user = await this.api.rest.get(`/api/v1/users/${id}`);
      if (user.status === "DEPROVISIONED") {
        return { effective: "immediate", message: "The user was already deactivated in Okta." };
      }
      await this.api.rest.post(`/api/v1/users/${id}/lifecycle/deactivate`);
      // The licence is free at once, but Okta contracts are annual: the bill
      // only drops at the next true-up or renewal.
      return {
        effective: "end-of-cycle",
        message:
          "Deactivated in Okta. Their app assignments were removed; Okta bills annually, so the saving shows at your next true-up or renewal.",
      };
    });
  }

  // -------------------------------------------------------------------------
  // Delete
  // -------------------------------------------------------------------------

  /** Apps, authorization servers, zones and event hooks must be deactivated before deleting. */
  deleteResource(typeId: string, resourceId: string): PluginEffect<void> {
    return attempt(async () => {
      const id = pathEncode(externalIdOf(resourceId));
      const { rest } = this.api;
      switch (typeId) {
        case "user": {
          const user = await rest.get(`/api/v1/users/${id}`);
          // The first DELETE of a non-deprovisioned user only deactivates it.
          if (user.status !== "DEPROVISIONED") {
            await rest.post(`/api/v1/users/${id}/lifecycle/deactivate`);
          }
          await rest.delete(`/api/v1/users/${id}`);
          return;
        }
        case "group":
          await rest.delete(`/api/v1/groups/${id}`);
          return;
        case "app": {
          const app = await rest.get(`/api/v1/apps/${id}`);
          if (app.status === "ACTIVE") await rest.post(`/api/v1/apps/${id}/lifecycle/deactivate`);
          await rest.delete(`/api/v1/apps/${id}`);
          return;
        }
        case "authorization-server": {
          const server = await rest.get(`/api/v1/authorizationServers/${id}`);
          if (server.status === "ACTIVE") {
            await rest.post(`/api/v1/authorizationServers/${id}/lifecycle/deactivate`);
          }
          await rest.delete(`/api/v1/authorizationServers/${id}`);
          return;
        }
        case "policy":
          await rest.delete(`/api/v1/policies/${id}`);
          return;
        case "network-zone": {
          const zone = await rest.get(`/api/v1/zones/${id}`);
          if (zone.status === "ACTIVE") await rest.post(`/api/v1/zones/${id}/lifecycle/deactivate`);
          await rest.delete(`/api/v1/zones/${id}`);
          return;
        }
        case "api-token":
          await rest.delete(`/api/v1/api-tokens/${id}`);
          return;
        case "event-hook": {
          const hook = await rest.get(`/api/v1/eventHooks/${id}`);
          if (hook.status === "ACTIVE") {
            await rest.post(`/api/v1/eventHooks/${id}/lifecycle/deactivate`);
          }
          await rest.delete(`/api/v1/eventHooks/${id}`);
          return;
        }
        case "domain":
          await rest.delete(`/api/v1/domains/${id}`);
          return;
        case "trusted-origin":
          await rest.delete(`/api/v1/trustedOrigins/${id}`);
          return;
        default:
          throw new Error(`Okta plugin: cannot delete resource type "${typeId}"`);
      }
    });
  }

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  invokeAction(typeId: string, resourceId: string, actionId: string): PluginEffect<void> {
    return attempt(async () => {
      const id = pathEncode(externalIdOf(resourceId));
      const { rest } = this.api;
      const sendEmail = { query: { sendEmail: true } };
      switch (`${typeId}:${actionId}`) {
        case "app:activate":
          await rest.post(`/api/v1/apps/${id}/lifecycle/activate`);
          return;
        case "app:deactivate":
          await rest.post(`/api/v1/apps/${id}/lifecycle/deactivate`);
          return;
        case "authorization-server:activate":
          await rest.post(`/api/v1/authorizationServers/${id}/lifecycle/activate`);
          return;
        case "authorization-server:deactivate":
          await rest.post(`/api/v1/authorizationServers/${id}/lifecycle/deactivate`);
          return;
        case "policy:activate":
          await rest.post(`/api/v1/policies/${id}/lifecycle/activate`);
          return;
        case "policy:deactivate":
          await rest.post(`/api/v1/policies/${id}/lifecycle/deactivate`);
          return;
        case "network-zone:activate":
          await rest.post(`/api/v1/zones/${id}/lifecycle/activate`);
          return;
        case "network-zone:deactivate":
          await rest.post(`/api/v1/zones/${id}/lifecycle/deactivate`);
          return;
        case "event-hook:activate":
          await rest.post(`/api/v1/eventHooks/${id}/lifecycle/activate`);
          return;
        case "event-hook:deactivate":
          await rest.post(`/api/v1/eventHooks/${id}/lifecycle/deactivate`);
          return;
        case "trusted-origin:activate":
          await rest.post(`/api/v1/trustedOrigins/${id}/lifecycle/activate`);
          return;
        case "trusted-origin:deactivate":
          await rest.post(`/api/v1/trustedOrigins/${id}/lifecycle/deactivate`);
          return;
        case "user:activate":
          await rest.post(`/api/v1/users/${id}/lifecycle/activate`, sendEmail);
          return;
        case "user:reactivate":
          await rest.post(`/api/v1/users/${id}/lifecycle/reactivate`, sendEmail);
          return;
        case "user:deactivate":
          await rest.post(`/api/v1/users/${id}/lifecycle/deactivate`);
          return;
        case "user:suspend":
          await rest.post(`/api/v1/users/${id}/lifecycle/suspend`);
          return;
        case "user:unsuspend":
          await rest.post(`/api/v1/users/${id}/lifecycle/unsuspend`);
          return;
        case "user:unlock":
          await rest.post(`/api/v1/users/${id}/lifecycle/unlock`);
          return;
        case "user:reset-password":
          await rest.post(`/api/v1/users/${id}/lifecycle/reset_password`, sendEmail);
          return;
        case "user:expire-password":
          await rest.post(`/api/v1/users/${id}/lifecycle/expire_password`);
          return;
        case "user:reset-factors":
          await rest.post(`/api/v1/users/${id}/lifecycle/reset_factors`);
          return;
        case "user:clear-sessions":
          await rest.delete(`/api/v1/users/${id}/sessions`, { query: { oauthTokens: true } });
          return;
        case "authorization-server:rotate-keys":
          await rest.post(`/api/v1/authorizationServers/${id}/credentials/lifecycle/keyRotate`, {
            body: { use: "sig" },
          });
          return;
        case "event-hook:verify":
          await rest.post(`/api/v1/eventHooks/${id}/lifecycle/verify`);
          return;
        case "domain:verify":
          await rest.post(`/api/v1/domains/${id}/verify`);
          return;
      }
      throw new Error(`Okta plugin: unknown action "${actionId}" for type "${typeId}"`);
    });
  }

  executeNoSqlCommand(
    typeId: string,
    resourceId: string,
    _accountId: string,
    command: string,
    args: (string | number)[],
  ): PluginEffect<unknown> {
    return attempt(async () => {
      const values: Record<string, string> = JSON.parse(String(args[0] ?? "{}"));
      const id = pathEncode(externalIdOf(resourceId));
      const pick = (key: string, what: string) => {
        const value = values[key];
        if (!value) throw new Error(`Okta plugin: choose ${what}`);
        return pathEncode(value);
      };
      const { rest } = this.api;
      switch (`${typeId}:${command}`) {
        case "group:add-member":
          return rest.put(`/api/v1/groups/${id}/users/${pick("userId", "a user")}`);
        case "group:remove-member":
          return rest.delete(`/api/v1/groups/${id}/users/${pick("userId", "a user")}`);
        case "user:add-to-group":
          return rest.put(`/api/v1/groups/${pick("groupId", "a group")}/users/${id}`);
        case "user:remove-from-group":
          return rest.delete(`/api/v1/groups/${pick("groupId", "a group")}/users/${id}`);
        case "app:assign-group":
          return rest.put(`/api/v1/apps/${id}/groups/${pick("groupId", "a group")}`, { body: {} });
        case "app:unassign-group":
          return rest.delete(`/api/v1/apps/${id}/groups/${pick("groupId", "a group")}`);
        case "authorization-server:add-scope":
          return rest.post(`/api/v1/authorizationServers/${id}/scopes`, {
            body: {
              name: values["name"],
              description: values["description"] ?? "",
              consent: "IMPLICIT",
            },
          });
        case "authorization-server:delete-scope":
          return rest.delete(
            `/api/v1/authorizationServers/${id}/scopes/${pick("scopeId", "a scope")}`,
          );
        case "policy:activate-rule":
          return rest.post(
            `/api/v1/policies/${id}/rules/${pick("ruleId", "a rule")}/lifecycle/activate`,
          );
        case "policy:deactivate-rule":
          return rest.post(
            `/api/v1/policies/${id}/rules/${pick("ruleId", "a rule")}/lifecycle/deactivate`,
          );
        default:
          throw new Error(`Okta plugin: unknown command "${command}" for type "${typeId}"`);
      }
    });
  }

  // -------------------------------------------------------------------------
  // Detail enrichment + rendering
  // -------------------------------------------------------------------------

  enrichDetail(resource: ResourceInstance): PluginEffect<ResourceInstance> {
    return attempt(async () => {
      const id = pathEncode(externalIdOf(resource.id));
      const extra: Record<string, string> = {};
      switch (resource.resourceTypeId) {
        case "user": {
          const [groups, allGroups] = await Promise.all([
            this.api.list
              .getAll(`/api/v1/users/${id}/groups`, null, {
                maxPages: DETAIL_LIST_PAGES,
                partial: true,
              })
              .catch(noRows),
            this.groupOptions(),
          ]);
          extra["__groups__"] = JSON.stringify(
            groups.map((g) => ({ id: str(g.id), label: str(g.profile?.name), type: str(g.type) })),
          );
          extra["__groupOptions__"] = JSON.stringify(allGroups);
          break;
        }
        case "group": {
          const [members, users] = await Promise.all([
            this.api.list
              .getAll(`/api/v1/groups/${id}/users`, null, {
                query: { limit: 200 },
                maxPages: 3,
                partial: true,
              })
              .catch(noRows),
            this.userOptions(),
          ]);
          const memberIds = new Set(members.map((m) => str(m.id)));
          extra["__members__"] = JSON.stringify(
            members.map((m) => ({
              id: str(m.id),
              label: str(m.profile?.login),
              status: str(m.status),
            })),
          );
          extra["__candidates__"] = JSON.stringify(users.filter((u) => !memberIds.has(u.id)));
          break;
        }
        case "app": {
          const [groups, allGroups] = await Promise.all([
            this.api.list
              .getAll(`/api/v1/apps/${id}/groups`, null, {
                query: { limit: 200 },
                maxPages: 3,
                partial: true,
              })
              .catch(noRows),
            this.groupOptions(false),
          ]);
          const names = new Map(allGroups.map((g) => [g.id, g.label]));
          extra["__assigned__"] = JSON.stringify(
            groups.map((g) => ({ id: str(g.id), label: names.get(str(g.id)) ?? str(g.id) })),
          );
          extra["__groupOptions__"] = JSON.stringify(allGroups);
          break;
        }
        case "authorization-server": {
          const scopes = await this.api.list
            .getAll(`/api/v1/authorizationServers/${id}/scopes`, null, {
              query: { limit: 200 },
              maxPages: DETAIL_LIST_PAGES,
              partial: true,
            })
            .catch(noRows);
          const policies = await this.api.list
            .getAll(`/api/v1/authorizationServers/${id}/policies`, null, {
              maxPages: DETAIL_LIST_PAGES,
              partial: true,
            })
            .catch(noRows);
          extra["__scopes__"] = JSON.stringify(scopes);
          extra["__policies__"] = JSON.stringify(
            policies.map((p) => ({
              name: str(p.name),
              status: str(p.status),
              priority: p.priority,
            })),
          );
          break;
        }
        case "policy": {
          const rules = await this.api.list
            .getAll(`/api/v1/policies/${id}/rules`, null, {
              maxPages: DETAIL_LIST_PAGES,
              partial: true,
            })
            .catch(noRows);
          extra["__rules__"] = JSON.stringify(rules);
          break;
        }
        default:
          return resource;
      }
      return { ...resource, resolvedOutputs: { ...resource.resolvedOutputs, ...extra } };
    });
  }

  renderDetail(resource: ResourceInstance): DetailViewSchema {
    return renderDetail(resource, this.api.orgUrl);
  }

  renderSidebarItem(resource: ResourceInstance): SidebarItemSchema {
    return renderSidebarItem(resource);
  }
}
