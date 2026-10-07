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
  SelectOption,
  SidebarItemSchema,
} from "@infrawrench/plugin-base";
import { externalIdOf } from "@infrawrench/plugin-base";
import { OktaApi, readCredentials } from "./api.js";
import { renderDetail, renderSidebarItem } from "./render.js";
import type {
  OktaApiToken,
  OktaApp,
  OktaAuthServer,
  OktaDomain,
  OktaEventHook,
  OktaGroup,
  OktaLogEvent,
  OktaOrg,
  OktaPolicy,
  OktaRule,
  OktaScope,
  OktaTrustedOrigin,
  OktaUser,
  OktaZone,
  OktaZoneAddress,
} from "./types.js";

const PLUGIN_ID = "okta";

export const METRICS_DEFAULT_RANGE_MS = 24 * 60 * 60 * 1000;
const METRIC_BUCKETS = 48;
/** System Log pages (1000 events each) read for one metrics window. */
const MAX_LOG_PAGES = 5;

/** Every policy type `GET /api/v1/policies?type=` accepts (the parameter is required). */
export const POLICY_TYPES = [
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

function str(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : String(value);
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

function addresses(value: string | undefined): OktaZoneAddress[] {
  return list(value).map((entry) => ({
    type: entry.includes("-") ? "RANGE" : "CIDR",
    value: entry,
  }));
}

function zoneList(value: unknown, key: "locations" | "asns"): string {
  if (!value) return "";
  const items = Array.isArray(value) ? value : ((value as { include?: unknown[] }).include ?? []);
  return items
    .map((item) => {
      if (typeof item === "string") return item;
      if (key === "locations" && item && typeof item === "object") {
        const loc = item as { country?: string; region?: string | null };
        return loc.region ? `${str(loc.country)}-${str(loc.region)}` : str(loc.country);
      }
      return "";
    })
    .filter(Boolean)
    .join(", ");
}

export class OktaClient implements PluginClient {
  readonly api: OktaApi;
  private orgCache: Promise<OktaOrg> | null = null;

  constructor(credentials: Record<string, string>, services?: HostServices) {
    this.api = new OktaApi(readCredentials(credentials), services);
  }

  private org(): Promise<OktaOrg> {
    this.orgCache ??= this.api.request<OktaOrg>("/api/v1/org");
    this.orgCache.catch(() => {
      this.orgCache = null;
    });
    return this.orgCache;
  }

  // -------------------------------------------------------------------------
  // Listing
  // -------------------------------------------------------------------------

  async listResources(typeId: string, accountId: string): Promise<ResourceInstance[]> {
    switch (typeId) {
      case "org":
        return [this.mapOrg(accountId, await this.org())];
      case "user":
        return (await this.api.paginate<OktaUser>("/api/v1/users", { limit: 200 })).map((u) =>
          this.mapUser(accountId, u),
        );
      case "group":
        return (
          await this.api.paginate<OktaGroup>("/api/v1/groups", { limit: 1000, expand: "stats" })
        ).map((g) => this.mapGroup(accountId, g));
      case "app":
        return (await this.api.paginate<OktaApp>("/api/v1/apps", { limit: 200 })).map((a) =>
          this.mapApp(accountId, a),
        );
      case "authorization-server":
        return (
          await this.api.paginate<OktaAuthServer>("/api/v1/authorizationServers", { limit: 200 })
        ).map((s) => this.mapAuthServer(accountId, s));
      case "policy": {
        const settled = await Promise.allSettled(
          POLICY_TYPES.map((type) =>
            this.api.paginate<OktaPolicy>("/api/v1/policies", { type }, 5),
          ),
        );
        return settled.flatMap((result, i) => {
          if (result.status === "fulfilled")
            return result.value.map((p) => this.mapPolicy(accountId, p));
          // Feature-gated policy types answer 400/404 on orgs without the feature.
          const status = (result.reason as { status?: number }).status;
          if (status !== 400 && status !== 404) {
            console.warn(
              `Okta plugin: skipping ${POLICY_TYPES[i]} policies: ${String(result.reason)}`,
            );
          }
          return [];
        });
      }
      case "network-zone":
        return (await this.api.paginate<OktaZone>("/api/v1/zones")).map((z) =>
          this.mapZone(accountId, z),
        );
      case "api-token":
        return (await this.api.paginate<OktaApiToken>("/api/v1/api-tokens")).map((t) =>
          this.mapApiToken(accountId, t),
        );
      case "event-hook":
        return (await this.api.request<OktaEventHook[]>("/api/v1/eventHooks")).map((h) =>
          this.mapEventHook(accountId, h),
        );
      case "domain": {
        const body = await this.api.request<{ domains?: OktaDomain[] }>("/api/v1/domains");
        return (body.domains ?? []).map((d) => this.mapDomain(accountId, d));
      }
      case "trusted-origin":
        return (
          await this.api.paginate<OktaTrustedOrigin>("/api/v1/trustedOrigins", { limit: 200 })
        ).map((t) => this.mapTrustedOrigin(accountId, t));
      default:
        throw new Error(`Okta plugin: unknown resource type "${typeId}"`);
    }
  }

  async getResource(
    typeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<ResourceInstance> {
    const id = encodeURIComponent(externalIdOf(resourceId));
    switch (typeId) {
      case "org":
        this.orgCache = null;
        return this.mapOrg(accountId, await this.org());
      case "user":
        return this.mapUser(accountId, await this.api.request<OktaUser>(`/api/v1/users/${id}`));
      case "group":
        return this.mapGroup(
          accountId,
          await this.api.request<OktaGroup>(`/api/v1/groups/${id}`, { query: { expand: "stats" } }),
        );
      case "app":
        return this.mapApp(accountId, await this.api.request<OktaApp>(`/api/v1/apps/${id}`));
      case "authorization-server":
        return this.mapAuthServer(
          accountId,
          await this.api.request<OktaAuthServer>(`/api/v1/authorizationServers/${id}`),
        );
      case "policy":
        return this.mapPolicy(
          accountId,
          await this.api.request<OktaPolicy>(`/api/v1/policies/${id}`),
        );
      case "network-zone":
        return this.mapZone(accountId, await this.api.request<OktaZone>(`/api/v1/zones/${id}`));
      case "api-token":
        return this.mapApiToken(
          accountId,
          await this.api.request<OktaApiToken>(`/api/v1/api-tokens/${id}`),
        );
      case "event-hook":
        return this.mapEventHook(
          accountId,
          await this.api.request<OktaEventHook>(`/api/v1/eventHooks/${id}`),
        );
      case "domain":
        return this.mapDomain(
          accountId,
          await this.api.request<OktaDomain>(`/api/v1/domains/${id}`),
        );
      case "trusted-origin":
        return this.mapTrustedOrigin(
          accountId,
          await this.api.request<OktaTrustedOrigin>(`/api/v1/trustedOrigins/${id}`),
        );
      default:
        throw new Error(`Okta plugin: unknown resource type "${typeId}"`);
    }
  }

  async resolveOutput(
    typeId: string,
    resourceId: string,
    outputKey: string,
    accountId: string,
  ): Promise<string> {
    const resource = await this.getResource(typeId, resourceId, accountId);
    const value = resource.resolvedOutputs[outputKey];
    if (value !== undefined && value !== "") return value;
    throw new Error(`Okta plugin: cannot resolve output "${outputKey}" for type "${typeId}"`);
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

  mapOrg(accountId: string, org: OktaOrg): ResourceInstance {
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

  mapUser(accountId: string, u: OktaUser): ResourceInstance {
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

  mapGroup(accountId: string, g: OktaGroup): ResourceInstance {
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

  mapApp(accountId: string, a: OktaApp): ResourceInstance {
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

  mapAuthServer(accountId: string, s: OktaAuthServer): ResourceInstance {
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

  mapPolicy(accountId: string, p: OktaPolicy): ResourceInstance {
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

  mapZone(accountId: string, z: OktaZone): ResourceInstance {
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

  mapApiToken(accountId: string, t: OktaApiToken): ResourceInstance {
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

  mapEventHook(accountId: string, h: OktaEventHook): ResourceInstance {
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

  mapDomain(accountId: string, d: OktaDomain): ResourceInstance {
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

  mapTrustedOrigin(accountId: string, t: OktaTrustedOrigin): ResourceInstance {
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

  async verifyCredentials(): Promise<PreflightResult> {
    const checks: PreflightCapabilityCheck[] = [];
    const probe = async (
      capabilityId: string,
      path: string,
      scope: string,
      query?: Record<string, string>,
    ) => {
      try {
        await this.api.request(path, { query: { limit: 1, ...query } });
        checks.push({ capabilityId, status: "ok" });
      } catch (error) {
        const status = (error as { status?: number }).status;
        if (status === 401 || status === 403) {
          checks.push({
            capabilityId,
            status: "missing",
            missingPermissions: [{ id: scope, label: scope }],
            message: (error as Error).message,
          });
        } else {
          checks.push({ capabilityId, status: "unknown", message: (error as Error).message });
        }
      }
    };
    let identity = "";
    try {
      const org = await this.org();
      identity = str(org.companyName) || str(org.subdomain);
      checks.push({ capabilityId: "org", status: "ok" });
    } catch (error) {
      const status = (error as { status?: number }).status;
      checks.push(
        status === 401 || status === 403
          ? {
              capabilityId: "org",
              status: "missing",
              missingPermissions: [{ id: "okta.orgs.read", label: "okta.orgs.read" }],
              message: (error as Error).message,
            }
          : { capabilityId: "org", status: "unknown", message: (error as Error).message },
      );
    }
    await probe("users", "/api/v1/users", "okta.users.read");
    await probe("groups", "/api/v1/groups", "okta.groups.read");
    await probe("apps", "/api/v1/apps", "okta.apps.read");
    await probe("security", "/api/v1/zones", "okta.networkZones.read");
    await probe("logs", "/api/v1/logs", "okta.logs.read");
    return { checks, ...(identity ? { identity } : {}) };
  }

  // -------------------------------------------------------------------------
  // Metrics, quotas, logs
  // -------------------------------------------------------------------------

  private async systemLog(
    query: Record<string, string | number>,
    maxPages: number,
  ): Promise<OktaLogEvent[]> {
    return this.api.paginate<OktaLogEvent>("/api/v1/logs", query, maxPages);
  }

  async fetchMetricSeries(
    resourceTypeId: string,
    _resourceId: string,
    _accountId: string,
    timeRange?: { startMs: number; endMs: number },
  ): Promise<MetricSeries[]> {
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
    const events = await this.systemLog(
      {
        since: new Date(startMs).toISOString(),
        until: new Date(endMs).toISOString(),
        filter,
        limit: 1000,
        sortOrder: "DESCENDING",
      },
      MAX_LOG_PAGES,
    );
    const bucketMs = Math.max(
      60_000,
      Math.ceil((endMs - startMs) / METRIC_BUCKETS / 60_000) * 60_000,
    );
    const buckets: number[] = [];
    for (let at = startMs; at < endMs; at += bucketMs) buckets.push(at);
    const series: Array<{ label: string; match: (e: OktaLogEvent) => boolean }> = [
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
        match: (e) => e.eventType === "user.authentication.sso" && e.outcome?.result === "SUCCESS",
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
  }

  /**
   * Okta has no API that reports rate-limit usage; each response carries the
   * per-minute `X-Rate-Limit-Limit`/`-Remaining` for its endpoint family, so
   * this probes a fixed set of the busiest families with `limit=1` reads and
   * reports what Okta said. Both halves come from the provider.
   */
  async fetchQuotas(_accountId: string): Promise<QuotaUsage[]> {
    const probes: Array<[string, string]> = [
      ["/api/v1/users", "Users API"],
      ["/api/v1/groups", "Groups API"],
      ["/api/v1/apps", "Apps API"],
      ["/api/v1/logs", "System Log API"],
      ["/api/v1/authorizationServers", "Authorization servers API"],
    ];
    const out: QuotaUsage[] = [];
    for (const [path, name] of probes) {
      const res = await this.api.call<unknown>(path, { query: { limit: 1 } });
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
  }

  async fetchDashboardStats(resourceTypeId: string, resourceId: string): Promise<DashboardStat[]> {
    const id = encodeURIComponent(externalIdOf(resourceId));
    if (resourceTypeId === "group") {
      const g = await this.api.request<OktaGroup>(`/api/v1/groups/${id}`, {
        query: { expand: "stats" },
      });
      return [
        { label: "Members", value: String(g._embedded?.stats?.usersCount ?? 0) },
        { label: "Apps", value: String(g._embedded?.stats?.appsCount ?? 0) },
      ];
    }
    if (resourceTypeId === "app") {
      const [users, groups] = await Promise.all([
        this.api.paginate<unknown>(`/api/v1/apps/${id}/users`, { limit: 500 }, 4).catch(() => []),
        this.api.paginate<unknown>(`/api/v1/apps/${id}/groups`, { limit: 200 }, 4).catch(() => []),
      ]);
      return [
        { label: "Assigned users", value: String(users.length) },
        { label: "Assigned groups", value: String(groups.length) },
      ];
    }
    return [];
  }

  async getLogs(
    typeId: string,
    resourceId: string,
    _accountId: string,
    params: LogsFetchParams,
  ): Promise<LogsFetchResult> {
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
    const events = await this.api.request<OktaLogEvent[]>("/api/v1/logs", {
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
  }

  // -------------------------------------------------------------------------
  // Create
  // -------------------------------------------------------------------------

  private async groupOptions(oktaOnly = true): Promise<SelectOption[]> {
    const groups = await this.api
      .paginate<OktaGroup>("/api/v1/groups", { limit: 1000 }, 5)
      .catch(() => [] as OktaGroup[]);
    return groups
      .filter((g) => !oktaOnly || g.type === "OKTA_GROUP")
      .map((g) => ({
        id: str(g.id),
        label: str(g.profile?.name),
        ...(g.profile?.description ? { description: str(g.profile.description) } : {}),
      }));
  }

  private async userOptions(): Promise<SelectOption[]> {
    const users = await this.api
      .paginate<OktaUser>("/api/v1/users", { limit: 200, filter: 'status eq "ACTIVE"' }, 5)
      .catch(() => [] as OktaUser[]);
    return users.map((u) => ({ id: str(u.id), label: str(u.profile?.login) }));
  }

  async getCreateConfig(typeId: string): Promise<CreateResourceConfig> {
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
  }

  private eventOptions(): PolicyOption[] {
    return EVENT_HOOK_TYPES.map((type) => ({
      id: type,
      label: type,
      category: type.split(".")[0] ?? type,
    }));
  }

  async createResource(
    typeId: string,
    accountId: string,
    fields: Record<string, string>,
  ): Promise<ResourceInstance> {
    switch (typeId) {
      case "user": {
        const activation = fields["activation"] || "email";
        const email = (fields["email"] ?? "").trim();
        const body: Record<string, unknown> = {
          profile: {
            firstName: fields["firstName"],
            lastName: fields["lastName"],
            email,
            login: (fields["login"] ?? "").trim() || email,
          },
        };
        const groupIds = list(fields["groupIds"]);
        if (groupIds.length > 0) body["groupIds"] = groupIds;
        if (activation === "password" && fields["password"]) {
          body["credentials"] = { password: { value: fields["password"] } };
        }
        const user = await this.api.request<OktaUser>("/api/v1/users", {
          method: "POST",
          query: {
            activate: activation !== "staged",
            ...(activation === "password" && fields["changePassword"] !== "false"
              ? { nextLogin: "changePassword" }
              : {}),
          },
          body,
        });
        return this.mapUser(accountId, user);
      }
      case "group": {
        const group = await this.api.request<OktaGroup>("/api/v1/groups", {
          method: "POST",
          body: { profile: { name: fields["name"], description: fields["description"] ?? "" } },
        });
        return this.mapGroup(accountId, group);
      }
      case "authorization-server": {
        const server = await this.api.request<OktaAuthServer>("/api/v1/authorizationServers", {
          method: "POST",
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
        const zone = await this.api.request<OktaZone>("/api/v1/zones", {
          method: "POST",
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
        const hook = await this.api.request<OktaEventHook>("/api/v1/eventHooks", {
          method: "POST",
          body: {
            name: fields["name"],
            events: { type: "EVENT_TYPE", items: events },
            channel: {
              type: "HTTP",
              version: "1.0.0",
              config: {
                uri: fields["uri"],
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
        const domain = await this.api.request<OktaDomain>("/api/v1/domains", {
          method: "POST",
          body: {
            domain: fields["domain"],
            certificateSourceType: fields["certificateSourceType"] || "OKTA_MANAGED",
          },
        });
        return this.mapDomain(accountId, domain);
      }
      case "trusted-origin": {
        const scopes = list(fields["scopes"]);
        const origin = await this.api.request<OktaTrustedOrigin>("/api/v1/trustedOrigins", {
          method: "POST",
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
  }

  // -------------------------------------------------------------------------
  // Update
  // -------------------------------------------------------------------------

  async updateResource(
    typeId: string,
    resourceId: string,
    accountId: string,
    fields: Record<string, string>,
  ): Promise<ResourceInstance> {
    const id = encodeURIComponent(externalIdOf(resourceId));
    switch (typeId) {
      case "org": {
        // POST /api/v1/org is a partial update; PUT would replace every field.
        const body: Record<string, string> = {};
        for (const key of [
          "companyName",
          "website",
          "phoneNumber",
          "supportPhoneNumber",
          "endUserSupportHelpURL",
          "address1",
          "city",
          "state",
          "postalCode",
          "country",
        ]) {
          if (fields[key] !== undefined) body[key] = fields[key]!;
        }
        this.orgCache = null;
        return this.mapOrg(
          accountId,
          await this.api.request<OktaOrg>("/api/v1/org", { method: "POST", body }),
        );
      }
      case "user": {
        // POST /api/v1/users/{id} is a partial profile update.
        const profile: Record<string, string> = {};
        for (const key of [
          "login",
          "email",
          "firstName",
          "lastName",
          "displayName",
          "title",
          "department",
          "mobilePhone",
        ]) {
          if (fields[key] !== undefined) profile[key] = fields[key]!;
        }
        return this.mapUser(
          accountId,
          await this.api.request<OktaUser>(`/api/v1/users/${id}`, {
            method: "POST",
            body: { profile },
          }),
        );
      }
      case "group": {
        const current = await this.api.request<OktaGroup>(`/api/v1/groups/${id}`);
        if (current.type !== "OKTA_GROUP") {
          throw Object.assign(new Error("Okta plugin: only Okta-mastered groups can be edited"), {
            status: 400,
          });
        }
        await this.api.request(`/api/v1/groups/${id}`, {
          method: "PUT",
          body: {
            profile: {
              name: fields["name"] ?? current.profile?.name,
              description: fields["description"] ?? current.profile?.description ?? "",
            },
          },
        });
        return this.getResource(typeId, resourceId, accountId);
      }
      case "app": {
        // Apps only support full replacement: read, change, write back.
        const current = await this.api.request<OktaApp>(`/api/v1/apps/${id}`);
        if (fields["label"] !== undefined) current.label = fields["label"];
        return this.mapApp(
          accountId,
          await this.api.request<OktaApp>(`/api/v1/apps/${id}`, { method: "PUT", body: current }),
        );
      }
      case "authorization-server": {
        const current = await this.api.request<OktaAuthServer>(
          `/api/v1/authorizationServers/${id}`,
        );
        const body = {
          name: fields["name"] ?? current.name,
          description: fields["description"] ?? current.description ?? "",
          audiences:
            fields["audiences"] !== undefined ? list(fields["audiences"]) : current.audiences,
          ...(fields["issuerMode"] || current.issuerMode
            ? { issuerMode: fields["issuerMode"] || current.issuerMode }
            : {}),
        };
        return this.mapAuthServer(
          accountId,
          await this.api.request<OktaAuthServer>(`/api/v1/authorizationServers/${id}`, {
            method: "PUT",
            body,
          }),
        );
      }
      case "policy": {
        const current = await this.api.request<OktaPolicy>(`/api/v1/policies/${id}`);
        const body: OktaPolicy = { ...current };
        delete body["_links"];
        if (fields["name"] !== undefined) body.name = fields["name"];
        if (fields["description"] !== undefined) body.description = fields["description"];
        if (fields["priority"]) body.priority = Number(fields["priority"]);
        return this.mapPolicy(
          accountId,
          await this.api.request<OktaPolicy>(`/api/v1/policies/${id}`, { method: "PUT", body }),
        );
      }
      case "network-zone": {
        const current = await this.api.request<OktaZone>(`/api/v1/zones/${id}`);
        const body: OktaZone = { ...current };
        delete body["_links"];
        if (fields["name"] !== undefined) body.name = fields["name"];
        if (current.type === "IP") {
          if (fields["gateways"] !== undefined) body.gateways = addresses(fields["gateways"]);
          if (fields["proxies"] !== undefined) body.proxies = addresses(fields["proxies"]);
        }
        return this.mapZone(
          accountId,
          await this.api.request<OktaZone>(`/api/v1/zones/${id}`, { method: "PUT", body }),
        );
      }
      case "event-hook": {
        const current = await this.api.request<OktaEventHook>(`/api/v1/eventHooks/${id}`);
        const config = { ...(current.channel?.config ?? {}) };
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
        const body = {
          name: fields["name"] ?? current.name,
          description: fields["description"] ?? current.description ?? null,
          events: {
            type: "EVENT_TYPE",
            items:
              fields["events"] !== undefined
                ? list(fields["events"])
                : (current.events?.items ?? []),
          },
          channel: {
            type: "HTTP",
            version: current.channel?.version ?? "1.0.0",
            config: { ...config, uri: fields["uri"] ?? config.uri },
          },
        };
        return this.mapEventHook(
          accountId,
          await this.api.request<OktaEventHook>(`/api/v1/eventHooks/${id}`, {
            method: "PUT",
            body,
          }),
        );
      }
      case "trusted-origin": {
        const current = await this.api.request<OktaTrustedOrigin>(`/api/v1/trustedOrigins/${id}`);
        const types = new Set((current.scopes ?? []).map((s) => str(s.type)));
        const cors = bool(fields["cors"]);
        const redirect = bool(fields["redirect"]);
        if (cors !== undefined) cors ? types.add("CORS") : types.delete("CORS");
        if (redirect !== undefined) redirect ? types.add("REDIRECT") : types.delete("REDIRECT");
        const body = {
          name: fields["name"] ?? current.name,
          origin: fields["origin"] ?? current.origin,
          scopes: [...types].map((type) => ({ type })),
        };
        return this.mapTrustedOrigin(
          accountId,
          await this.api.request<OktaTrustedOrigin>(`/api/v1/trustedOrigins/${id}`, {
            method: "PUT",
            body,
          }),
        );
      }
      default:
        throw new Error(`Okta plugin: cannot update resource type "${typeId}"`);
    }
  }

  // -------------------------------------------------------------------------
  // Delete
  // -------------------------------------------------------------------------

  /** Deactivate first where Okta refuses to delete an active object. */
  private async deactivateThenDelete(base: string, status: string | undefined): Promise<void> {
    if (status === "ACTIVE")
      await this.api.request(`${base}/lifecycle/deactivate`, { method: "POST" });
    await this.api.request(base, { method: "DELETE" });
  }

  async deleteResource(typeId: string, resourceId: string): Promise<void> {
    const id = encodeURIComponent(externalIdOf(resourceId));
    switch (typeId) {
      case "user": {
        const user = await this.api.request<OktaUser>(`/api/v1/users/${id}`);
        // The first DELETE of a non-deprovisioned user only deactivates it.
        if (user.status !== "DEPROVISIONED") {
          await this.api.request(`/api/v1/users/${id}/lifecycle/deactivate`, { method: "POST" });
        }
        await this.api.request(`/api/v1/users/${id}`, { method: "DELETE" });
        return;
      }
      case "group":
        await this.api.request(`/api/v1/groups/${id}`, { method: "DELETE" });
        return;
      case "app": {
        const app = await this.api.request<OktaApp>(`/api/v1/apps/${id}`);
        return this.deactivateThenDelete(`/api/v1/apps/${id}`, app.status);
      }
      case "authorization-server": {
        const server = await this.api.request<OktaAuthServer>(`/api/v1/authorizationServers/${id}`);
        return this.deactivateThenDelete(`/api/v1/authorizationServers/${id}`, server.status);
      }
      case "policy":
        await this.api.request(`/api/v1/policies/${id}`, { method: "DELETE" });
        return;
      case "network-zone": {
        const zone = await this.api.request<OktaZone>(`/api/v1/zones/${id}`);
        return this.deactivateThenDelete(`/api/v1/zones/${id}`, zone.status);
      }
      case "api-token":
        await this.api.request(`/api/v1/api-tokens/${id}`, { method: "DELETE" });
        return;
      case "event-hook": {
        const hook = await this.api.request<OktaEventHook>(`/api/v1/eventHooks/${id}`);
        return this.deactivateThenDelete(`/api/v1/eventHooks/${id}`, hook.status);
      }
      case "domain":
        await this.api.request(`/api/v1/domains/${id}`, { method: "DELETE" });
        return;
      case "trusted-origin":
        await this.api.request(`/api/v1/trustedOrigins/${id}`, { method: "DELETE" });
        return;
      default:
        throw new Error(`Okta plugin: cannot delete resource type "${typeId}"`);
    }
  }

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  async invokeAction(typeId: string, resourceId: string, actionId: string): Promise<void> {
    const id = encodeURIComponent(externalIdOf(resourceId));
    const lifecycle: Record<string, string> = {
      app: "/api/v1/apps",
      "authorization-server": "/api/v1/authorizationServers",
      policy: "/api/v1/policies",
      "network-zone": "/api/v1/zones",
      "event-hook": "/api/v1/eventHooks",
      "trusted-origin": "/api/v1/trustedOrigins",
    };
    const base = lifecycle[typeId];
    if (base && (actionId === "activate" || actionId === "deactivate")) {
      await this.api.request(`${base}/${id}/lifecycle/${actionId}`, { method: "POST" });
      return;
    }
    if (typeId === "user") {
      const userActions: Record<
        string,
        { path: string; method: string; query?: Record<string, string | boolean> }
      > = {
        activate: { path: "lifecycle/activate", method: "POST", query: { sendEmail: true } },
        reactivate: { path: "lifecycle/reactivate", method: "POST", query: { sendEmail: true } },
        deactivate: { path: "lifecycle/deactivate", method: "POST" },
        suspend: { path: "lifecycle/suspend", method: "POST" },
        unsuspend: { path: "lifecycle/unsuspend", method: "POST" },
        unlock: { path: "lifecycle/unlock", method: "POST" },
        "reset-password": {
          path: "lifecycle/reset_password",
          method: "POST",
          query: { sendEmail: true },
        },
        "expire-password": { path: "lifecycle/expire_password", method: "POST" },
        "reset-factors": { path: "lifecycle/reset_factors", method: "POST" },
        "clear-sessions": { path: "sessions", method: "DELETE", query: { oauthTokens: true } },
      };
      const action = userActions[actionId];
      if (action) {
        await this.api.request(`/api/v1/users/${id}/${action.path}`, {
          method: action.method,
          ...(action.query ? { query: action.query } : {}),
        });
        return;
      }
    }
    if (typeId === "authorization-server" && actionId === "rotate-keys") {
      await this.api.request(`/api/v1/authorizationServers/${id}/credentials/lifecycle/keyRotate`, {
        method: "POST",
        body: { use: "sig" },
      });
      return;
    }
    if (typeId === "event-hook" && actionId === "verify") {
      await this.api.request(`/api/v1/eventHooks/${id}/lifecycle/verify`, { method: "POST" });
      return;
    }
    if (typeId === "domain" && actionId === "verify") {
      await this.api.request(`/api/v1/domains/${id}/verify`, { method: "POST" });
      return;
    }
    throw new Error(`Okta plugin: unknown action "${actionId}" for type "${typeId}"`);
  }

  async executeNoSqlCommand(
    typeId: string,
    resourceId: string,
    _accountId: string,
    command: string,
    args: (string | number)[],
  ): Promise<unknown> {
    const values = JSON.parse(String(args[0] ?? "{}")) as Record<string, string>;
    const id = encodeURIComponent(externalIdOf(resourceId));
    const pick = (key: string, what: string): string => {
      const value = values[key];
      if (!value) throw new Error(`Okta plugin: choose ${what}`);
      return encodeURIComponent(value);
    };
    switch (`${typeId}:${command}`) {
      case "group:add-member":
        return this.api.request(`/api/v1/groups/${id}/users/${pick("userId", "a user")}`, {
          method: "PUT",
        });
      case "group:remove-member":
        return this.api.request(`/api/v1/groups/${id}/users/${pick("userId", "a user")}`, {
          method: "DELETE",
        });
      case "user:add-to-group":
        return this.api.request(`/api/v1/groups/${pick("groupId", "a group")}/users/${id}`, {
          method: "PUT",
        });
      case "user:remove-from-group":
        return this.api.request(`/api/v1/groups/${pick("groupId", "a group")}/users/${id}`, {
          method: "DELETE",
        });
      case "app:assign-group":
        return this.api.request(`/api/v1/apps/${id}/groups/${pick("groupId", "a group")}`, {
          method: "PUT",
          body: {},
        });
      case "app:unassign-group":
        return this.api.request(`/api/v1/apps/${id}/groups/${pick("groupId", "a group")}`, {
          method: "DELETE",
        });
      case "authorization-server:add-scope":
        return this.api.request(`/api/v1/authorizationServers/${id}/scopes`, {
          method: "POST",
          body: {
            name: values["name"],
            description: values["description"] ?? "",
            consent: "IMPLICIT",
          },
        });
      case "authorization-server:delete-scope":
        return this.api.request(
          `/api/v1/authorizationServers/${id}/scopes/${pick("scopeId", "a scope")}`,
          {
            method: "DELETE",
          },
        );
      case "policy:activate-rule":
      case "policy:deactivate-rule": {
        const verb = command.startsWith("activate") ? "activate" : "deactivate";
        return this.api.request(
          `/api/v1/policies/${id}/rules/${pick("ruleId", "a rule")}/lifecycle/${verb}`,
          {
            method: "POST",
          },
        );
      }
      default:
        throw new Error(`Okta plugin: unknown command "${command}" for type "${typeId}"`);
    }
  }

  // -------------------------------------------------------------------------
  // Detail enrichment + rendering
  // -------------------------------------------------------------------------

  async enrichDetail(resource: ResourceInstance): Promise<ResourceInstance> {
    const id = encodeURIComponent(externalIdOf(resource.id));
    const extra: Record<string, string> = {};
    switch (resource.resourceTypeId) {
      case "user": {
        const [groups, allGroups] = await Promise.all([
          this.api
            .request<OktaGroup[]>(`/api/v1/users/${id}/groups`)
            .catch(() => [] as OktaGroup[]),
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
          this.api
            .paginate<OktaUser>(`/api/v1/groups/${id}/users`, { limit: 200 }, 3)
            .catch(() => [] as OktaUser[]),
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
          this.api
            .paginate<{ id?: string }>(`/api/v1/apps/${id}/groups`, { limit: 200 }, 3)
            .catch(() => []),
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
        const scopes = await this.api
          .request<OktaScope[]>(`/api/v1/authorizationServers/${id}/scopes`)
          .catch(() => [] as OktaScope[]);
        const policies = await this.api
          .request<OktaPolicy[]>(`/api/v1/authorizationServers/${id}/policies`)
          .catch(() => [] as OktaPolicy[]);
        extra["__scopes__"] = JSON.stringify(scopes);
        extra["__policies__"] = JSON.stringify(
          policies.map((p) => ({ name: str(p.name), status: str(p.status), priority: p.priority })),
        );
        break;
      }
      case "policy": {
        const rules = await this.api
          .request<OktaRule[]>(`/api/v1/policies/${id}/rules`)
          .catch(() => [] as OktaRule[]);
        extra["__rules__"] = JSON.stringify(rules);
        break;
      }
      default:
        return resource;
    }
    return { ...resource, resolvedOutputs: { ...resource.resolvedOutputs, ...extra } };
  }

  renderDetail(resource: ResourceInstance): DetailViewSchema {
    return renderDetail(resource, this.api.orgUrl);
  }

  renderSidebarItem(resource: ResourceInstance): SidebarItemSchema {
    return renderSidebarItem(resource);
  }
}
