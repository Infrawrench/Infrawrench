import type {
  CreateResourceConfig,
  CredentialExport,
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
  SettingDescriptor,
  SidebarItemSchema,
} from "@infrawrench/plugin-base";
import { externalIdOf } from "@infrawrench/plugin-base";
import { Auth0Api, readCredentials, regionOfDomain } from "./api.js";
import { renderDetail, renderSidebarItem } from "./render.js";
import type {
  A0Action,
  A0Binding,
  A0Branding,
  A0Client,
  A0Connection,
  A0CustomDomain,
  A0DailyStat,
  A0Log,
  A0LogStream,
  A0Organization,
  A0ResourceServer,
  A0Role,
  A0TenantSettings,
  A0Trigger,
  A0User,
} from "./types.js";

const PLUGIN_ID = "auth0";
export const METRICS_DEFAULT_RANGE_MS = 30 * 24 * 60 * 60 * 1000;

/** Starter code for a new Action, per trigger family. */
const ACTION_TEMPLATE = `/**
 * Handler that will be called during the execution of the flow.
 * @param {Event} event - Details about the context of the call.
 * @param {API} api - Methods that change the behavior of the flow.
 */
exports.onExecutePostLogin = async (event, api) => {
};
`;

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

/** Auth0 log `date` is either an ISO string or `{}` on malformed rows. */
function logDate(log: A0Log): string {
  return typeof log.date === "string" ? log.date : "";
}

/** The most common tenant log event codes (https://auth0.com/docs/deploy-monitor/logs/log-event-type-codes). */
export const LOG_TYPES: Record<string, string> = {
  s: "Successful login",
  f: "Failed login",
  fp: "Failed login (wrong password)",
  fu: "Failed login (invalid email/username)",
  ss: "Successful signup",
  fs: "Failed signup",
  seacft: "Successful code exchange",
  feacft: "Failed code exchange",
  seccft: "Successful client credentials exchange",
  feccft: "Failed client credentials exchange",
  sapi: "Management API write",
  fapi: "Failed Management API operation",
  limit_wc: "Blocked account (brute force)",
  limit_mu: "Blocked IP (too many logins)",
  pwd_leak: "Breached password",
  scp: "Password changed",
  fcp: "Password change failed",
  sv: "Email verified",
  slo: "Logout",
  gd_auth_succeed: "MFA succeeded",
  gd_auth_failed: "MFA failed",
  api_limit: "Rate limit reached",
};

export class Auth0Client implements PluginClient {
  readonly api: Auth0Api;

  constructor(credentials: Record<string, string>, services?: HostServices) {
    this.api = new Auth0Api(readCredentials(credentials), services);
  }

  // -------------------------------------------------------------------------
  // Listing
  // -------------------------------------------------------------------------

  async listResources(typeId: string, accountId: string): Promise<ResourceInstance[]> {
    switch (typeId) {
      case "tenant":
        return [await this.tenantResource(accountId)];
      case "application":
        return (await this.api.pages<A0Client>("/clients", "clients", { is_global: false })).map(
          (c) => this.mapClient(accountId, c),
        );
      case "api":
        return (
          await this.api.pages<A0ResourceServer>("/resource-servers", "resource_servers")
        ).map((r) => this.mapApi(accountId, r));
      case "connection": {
        const connections = await this.api.pages<A0Connection>("/connections", "connections");
        return connections.map((c) => this.mapConnection(accountId, c));
      }
      case "user":
        return (await this.api.pages<A0User>("/users", "users", { sort: "created_at:-1" })).map(
          (u) => this.mapUser(accountId, u),
        );
      case "role":
        return (await this.api.pages<A0Role>("/roles", "roles")).map((r) =>
          this.mapRole(accountId, r),
        );
      case "organization":
        return (await this.api.pages<A0Organization>("/organizations", "organizations")).map((o) =>
          this.mapOrganization(accountId, o),
        );
      case "action": {
        const [actions, bound] = await Promise.all([
          this.api.pages<A0Action>("/actions/actions", "actions"),
          this.boundActionIds(),
        ]);
        return actions.map((a) => this.mapAction(accountId, a, bound));
      }
      case "log-stream":
        return (await this.api.request<A0LogStream[]>("/log-streams")).map((s) =>
          this.mapLogStream(accountId, s),
        );
      case "custom-domain": {
        const body = await this.api.request<
          A0CustomDomain[] | { custom_domains?: A0CustomDomain[] }
        >("/custom-domains");
        const domains = Array.isArray(body) ? body : (body.custom_domains ?? []);
        return domains.map((d) => this.mapCustomDomain(accountId, d));
      }
      default:
        throw new Error(`Auth0 plugin: unknown resource type "${typeId}"`);
    }
  }

  async getResource(
    typeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<ResourceInstance> {
    const id = encodeURIComponent(externalIdOf(resourceId));
    switch (typeId) {
      case "tenant":
        return this.tenantResource(accountId);
      case "application":
        return this.mapClient(accountId, await this.api.request<A0Client>(`/clients/${id}`));
      case "api":
        return this.mapApi(
          accountId,
          await this.api.request<A0ResourceServer>(`/resource-servers/${id}`),
        );
      case "connection":
        return this.mapConnection(
          accountId,
          await this.api.request<A0Connection>(`/connections/${id}`),
        );
      case "user":
        return this.mapUser(accountId, await this.api.request<A0User>(`/users/${id}`));
      case "role": {
        const [role, permissions] = await Promise.all([
          this.api.request<A0Role>(`/roles/${id}`),
          this.rolePermissions(externalIdOf(resourceId)).catch(() => []),
        ]);
        return this.mapRole(
          accountId,
          role,
          permissions.map((p) => `${p.resource_server_identifier}:${p.permission_name}`),
        );
      }
      case "organization":
        return this.mapOrganization(
          accountId,
          await this.api.request<A0Organization>(`/organizations/${id}`),
        );
      case "action": {
        const [action, bound] = await Promise.all([
          this.api.request<A0Action>(`/actions/actions/${id}`),
          this.boundActionIds(),
        ]);
        return this.mapAction(accountId, action, bound);
      }
      case "log-stream":
        return this.mapLogStream(
          accountId,
          await this.api.request<A0LogStream>(`/log-streams/${id}`),
        );
      case "custom-domain":
        return this.mapCustomDomain(
          accountId,
          await this.api.request<A0CustomDomain>(`/custom-domains/${id}`),
        );
      default:
        throw new Error(`Auth0 plugin: unknown resource type "${typeId}"`);
    }
  }

  async resolveOutput(
    typeId: string,
    resourceId: string,
    outputKey: string,
    accountId: string,
  ): Promise<string> {
    if (typeId === "application" && outputKey === "clientSecret") {
      const client = await this.api.request<A0Client>(
        `/clients/${encodeURIComponent(externalIdOf(resourceId))}`,
        {
          query: { fields: "client_secret", include_fields: true },
        },
      );
      if (!client.client_secret)
        throw new Error("Auth0 plugin: this application has no client secret");
      return client.client_secret;
    }
    const resource = await this.getResource(typeId, resourceId, accountId);
    const value = resource.resolvedOutputs[outputKey];
    if (value !== undefined && value !== "") return value;
    throw new Error(`Auth0 plugin: cannot resolve output "${outputKey}" for type "${typeId}"`);
  }

  async rerollOutput(typeId: string, resourceId: string, outputKey: string): Promise<void> {
    if (typeId === "application" && outputKey === "clientSecret") {
      await this.api.request(
        `/clients/${encodeURIComponent(externalIdOf(resourceId))}/rotate-secret`,
        { method: "POST" },
      );
      return;
    }
    throw new Error(`Auth0 plugin: cannot reissue "${outputKey}"`);
  }

  private async rolePermissions(roleId: string) {
    return this.api.pages<{ resource_server_identifier?: string; permission_name?: string }>(
      `/roles/${encodeURIComponent(roleId)}/permissions`,
      "permissions",
    );
  }

  /** Action ids currently bound into any flow (one call per trigger). */
  private async boundActionIds(): Promise<Set<string>> {
    const triggers = await this.api
      .request<{ triggers?: A0Trigger[] }>("/actions/triggers")
      .catch(() => ({ triggers: [] }));
    const ids = new Set<string>();
    const unique = [...new Set((triggers.triggers ?? []).map((t) => str(t.id)).filter(Boolean))];
    const settled = await Promise.allSettled(
      unique.map((t) =>
        this.api.request<{ bindings?: A0Binding[] }>(
          `/actions/triggers/${encodeURIComponent(t)}/bindings`,
        ),
      ),
    );
    for (const result of settled) {
      if (result.status !== "fulfilled") continue;
      for (const b of result.value.bindings ?? []) if (b.action?.id) ids.add(b.action.id);
    }
    return ids;
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

  private async tenantResource(accountId: string): Promise<ResourceInstance> {
    const [settings, branding, active] = await Promise.all([
      this.api.request<A0TenantSettings>("/tenants/settings"),
      this.api.request<A0Branding>("/branding").catch(() => ({}) as A0Branding),
      this.api.request<number>("/stats/active-users").catch(() => undefined),
    ]);
    return this.mapTenant(accountId, settings, branding, active);
  }

  mapTenant(
    accountId: string,
    s: A0TenantSettings,
    b: A0Branding,
    activeUsers?: number,
  ): ResourceInstance {
    const domain = this.api.domain;
    const background =
      typeof b.colors?.page_background === "string" ? b.colors.page_background : "";
    return this.instance(
      accountId,
      "tenant",
      domain,
      str(s.friendly_name) || domain,
      {
        friendlyName: str(s.friendly_name),
        domain,
        region: regionOfDomain(domain),
        supportEmail: str(s.support_email),
        supportUrl: str(s.support_url),
        pictureUrl: str(s.picture_url),
        defaultAudience: str(s.default_audience),
        defaultDirectory: str(s.default_directory),
        ...(typeof s.session_lifetime === "number" ? { sessionLifetime: s.session_lifetime } : {}),
        ...(typeof s.idle_session_lifetime === "number"
          ? { idleSessionLifetime: s.idle_session_lifetime }
          : {}),
        enabledLocales: (s.enabled_locales ?? []).join(", "),
        sandboxVersion: str(s.sandbox_version),
        brandPrimaryColor: str(b.colors?.primary),
        brandBackgroundColor: background,
        brandLogoUrl: str(b.logo_url),
        brandFaviconUrl: str(b.favicon_url),
        ...(typeof activeUsers === "number" ? { activeUsers } : {}),
      },
      {
        domain,
        issuer: `https://${domain}/`,
        jwksUrl: `https://${domain}/.well-known/jwks.json`,
      },
    );
  }

  mapClient(accountId: string, c: A0Client): ResourceInstance {
    const id = str(c.client_id);
    return this.instance(
      accountId,
      "application",
      id,
      str(c.name),
      {
        name: str(c.name),
        description: str(c.description),
        appType: str(c.app_type),
        clientId: id,
        callbacks: (c.callbacks ?? []).join(", "),
        allowedLogoutUrls: (c.allowed_logout_urls ?? []).join(", "),
        webOrigins: (c.web_origins ?? []).join(", "),
        allowedOrigins: (c.allowed_origins ?? []).join(", "),
        grantTypes: (c.grant_types ?? []).join(", "),
        tokenEndpointAuthMethod: str(c.token_endpoint_auth_method),
        isFirstParty: c.is_first_party !== false,
        initiateLoginUri: str(c.initiate_login_uri),
        logoUri: str(c.logo_uri),
      },
      { clientId: id, domain: this.api.domain },
      c.created_at,
      c.updated_at,
    );
  }

  mapApi(accountId: string, r: A0ResourceServer): ResourceInstance {
    return this.instance(
      accountId,
      "api",
      str(r.id),
      str(r.name) || str(r.identifier),
      {
        name: str(r.name),
        identifier: str(r.identifier),
        signingAlg: str(r.signing_alg),
        ...(typeof r.token_lifetime === "number" ? { tokenLifetime: r.token_lifetime } : {}),
        ...(typeof r.token_lifetime_for_web === "number"
          ? { tokenLifetimeForWeb: r.token_lifetime_for_web }
          : {}),
        allowOfflineAccess: r.allow_offline_access === true,
        skipConsent: r.skip_consent_for_verifiable_first_party_clients === true,
        enforcePolicies: r.enforce_policies === true,
        tokenDialect: str(r.token_dialect),
        scopes: (r.scopes ?? []).map((s) => str(s.value)).join(", "),
        isSystem: r.is_system === true,
      },
      {
        identifier: str(r.identifier),
        apiId: str(r.id),
        __scopes__: JSON.stringify(r.scopes ?? []),
      },
    );
  }

  mapConnection(accountId: string, c: A0Connection): ResourceInstance {
    return this.instance(
      accountId,
      "connection",
      str(c.id),
      str(c.display_name) || str(c.name),
      {
        name: str(c.name),
        displayName: str(c.display_name),
        strategy: str(c.strategy),
        enabledClients: (c.enabled_clients ?? []).join(", "),
        isDomainConnection: c.is_domain_connection === true,
        showAsButton: c.show_as_button === true,
        realms: (c.realms ?? []).join(", "),
      },
      { connectionId: str(c.id), name: str(c.name) },
    );
  }

  mapUser(accountId: string, u: A0User): ResourceInstance {
    const id = str(u.user_id);
    return this.instance(
      accountId,
      "user",
      id,
      str(u.email) || str(u.name) || id,
      {
        email: str(u.email),
        name: str(u.name),
        nickname: str(u.nickname),
        emailVerified: u.email_verified === true,
        blocked: u.blocked === true,
        connection: str(u.identities?.[0]?.connection),
        userId: id,
        ...(typeof u.logins_count === "number" ? { loginsCount: u.logins_count } : {}),
        lastLogin: str(u.last_login),
        lastIp: str(u.last_ip),
        createdAt: str(u.created_at),
      },
      { userId: id },
      u.created_at,
      u.updated_at,
    );
  }

  mapRole(accountId: string, r: A0Role, permissions?: string[]): ResourceInstance {
    return this.instance(
      accountId,
      "role",
      str(r.id),
      str(r.name),
      {
        name: str(r.name),
        description: str(r.description),
        ...(permissions ? { permissions: permissions.join(", ") } : {}),
      },
      { roleId: str(r.id) },
    );
  }

  mapOrganization(accountId: string, o: A0Organization): ResourceInstance {
    const background =
      typeof o.branding?.colors?.page_background === "string"
        ? o.branding.colors.page_background
        : "";
    return this.instance(
      accountId,
      "organization",
      str(o.id),
      str(o.display_name) || str(o.name),
      {
        name: str(o.name),
        displayName: str(o.display_name),
        logoUrl: str(o.branding?.logo_url),
        primaryColor: str(o.branding?.colors?.primary),
        backgroundColor: background,
        organizationId: str(o.id),
      },
      { organizationId: str(o.id), name: str(o.name) },
    );
  }

  mapAction(accountId: string, a: A0Action, bound: Set<string>): ResourceInstance {
    const trigger = a.supported_triggers?.[0];
    return this.instance(
      accountId,
      "action",
      str(a.id),
      str(a.name),
      {
        name: str(a.name),
        trigger: trigger ? `${str(trigger.id)}@${str(trigger.version)}` : "",
        runtime: str(a.runtime),
        status: str(a.status),
        deployed: Boolean(a.deployed_version),
        allChangesDeployed: a.all_changes_deployed === true,
        bound: bound.has(str(a.id)),
        dependencies: (a.dependencies ?? [])
          .map((d) => `${str(d.name)}@${str(d.version)}`)
          .join(", "),
        secrets: (a.secrets ?? []).map((s) => str(s.name)).join(", "),
        updatedAt: str(a.updated_at),
      },
      { actionId: str(a.id), __code__: str(a.code) },
      a.created_at,
      a.updated_at,
    );
  }

  mapLogStream(accountId: string, s: A0LogStream): ResourceInstance {
    const sink = s.sink ?? {};
    const target =
      str(sink["httpEndpoint"]) ||
      (sink["datadogRegion"] ? `Datadog ${str(sink["datadogRegion"])}` : "") ||
      str(sink["splunkDomain"]) ||
      str(sink["sumoSourceAddress"]) ||
      (sink["awsAccountId"] ? `AWS ${str(sink["awsAccountId"])} ${str(sink["awsRegion"])}` : "") ||
      (sink["azureSubscriptionId"] ? `Azure ${str(sink["azureSubscriptionId"])}` : "") ||
      (sink["mixpanelProjectId"] ? `Mixpanel ${str(sink["mixpanelProjectId"])}` : "");
    return this.instance(
      accountId,
      "log-stream",
      str(s.id),
      str(s.name),
      {
        name: str(s.name),
        type: str(s.type),
        status: str(s.status),
        target,
        filters: (s.filters ?? []).map((f) => str(f.name)).join(", "),
        isPriority: s.isPriority === true,
      },
      { logStreamId: str(s.id) },
    );
  }

  mapCustomDomain(accountId: string, d: A0CustomDomain): ResourceInstance {
    return this.instance(
      accountId,
      "custom-domain",
      str(d.custom_domain_id),
      str(d.domain),
      {
        domain: str(d.domain),
        status: str(d.status),
        type: str(d.type),
        primary: d.primary === true,
        originDomainName: str(d.origin_domain_name),
        verificationStatus: str(d.verification?.status),
        certificateStatus: str(d.certificate?.status),
        certificateRenewsBefore: str(d.certificate?.renews_before),
        tlsPolicy: str(d.tls_policy),
        customClientIpHeader: str(d.custom_client_ip_header),
      },
      {
        domain: str(d.domain),
        originDomainName: str(d.origin_domain_name),
        __verification__: JSON.stringify(d.verification?.methods ?? []),
        __verificationError__: str(d.verification?.error_msg) || str(d.certificate?.error_msg),
      },
    );
  }

  // -------------------------------------------------------------------------
  // Preflight
  // -------------------------------------------------------------------------

  async verifyCredentials(): Promise<PreflightResult> {
    const checks: PreflightCapabilityCheck[] = [];
    const probe = async (capabilityId: string, path: string, scope: string) => {
      try {
        await this.api.request(path, { query: { per_page: 1 } });
        checks.push({ capabilityId, status: "ok" });
      } catch (error) {
        const status = (error as { status?: number }).status;
        checks.push(
          status === 401 || status === 403
            ? {
                capabilityId,
                status: "missing",
                missingPermissions: [{ id: scope, label: scope }],
                message: (error as Error).message,
              }
            : { capabilityId, status: "unknown", message: (error as Error).message },
        );
      }
    };
    await probe("tenant", "/tenants/settings", "read:tenant_settings");
    await probe("applications", "/clients", "read:clients");
    await probe("users", "/users", "read:users");
    await probe("actions", "/actions/actions", "read:actions");
    await probe("logs", "/logs", "read:logs");
    await probe("stats", "/stats/daily", "read:stats");
    return { checks, identity: this.api.domain };
  }

  // -------------------------------------------------------------------------
  // Metrics, quotas, logs
  // -------------------------------------------------------------------------

  async fetchMetricSeries(
    resourceTypeId: string,
    _resourceId: string,
    _accountId: string,
    timeRange?: { startMs: number; endMs: number },
  ): Promise<MetricSeries[]> {
    if (resourceTypeId !== "tenant") return [];
    const endMs = timeRange?.endMs ?? Date.now();
    const startMs = timeRange?.startMs ?? endMs - METRICS_DEFAULT_RANGE_MS;
    const ymd = (ms: number) => new Date(ms).toISOString().slice(0, 10).replace(/-/g, "");
    const days = await this.api.request<A0DailyStat[]>("/stats/daily", {
      query: { from: ymd(startMs), to: ymd(endMs) },
    });
    const points = (pick: (d: A0DailyStat) => number | undefined) =>
      (days ?? [])
        .map((d) => ({ timestamp: Date.parse(str(d.date)), value: pick(d) ?? 0 }))
        .filter((p) => Number.isFinite(p.timestamp))
        .sort((a, b) => a.timestamp - b.timestamp);
    return [
      { label: "Logins", unit: "count", points: points((d) => d.logins) },
      { label: "Signups", unit: "count", points: points((d) => d.signups) },
      { label: "Leaked passwords", unit: "count", points: points((d) => d.leaked_passwords) },
    ];
  }

  /**
   * Auth0 publishes no usage API for its rate limits; every Management API
   * response carries `x-ratelimit-limit`/`-remaining` for the tenant's
   * bucket, so one cheap read reports the headroom Auth0 states.
   */
  async fetchQuotas(_accountId: string): Promise<QuotaUsage[]> {
    const res = await this.api.call<unknown>("/stats/active-users");
    const limit = Number(res.headers["x-ratelimit-limit"]);
    const remaining = Number(res.headers["x-ratelimit-remaining"]);
    if (!Number.isFinite(limit) || !Number.isFinite(remaining) || limit <= 0) return [];
    return [
      {
        id: "management-api-rate-limit",
        service: "Management API",
        name: "Management API request bucket",
        limit,
        used: Math.max(0, limit - remaining),
        unit: "requests",
        adjustable: true,
        docsUrl:
          "https://auth0.com/docs/troubleshoot/customer-support/operational-policies/rate-limit-policy",
      },
    ];
  }

  async fetchDashboardStats(resourceTypeId: string, resourceId: string): Promise<DashboardStat[]> {
    const id = encodeURIComponent(externalIdOf(resourceId));
    if (resourceTypeId === "tenant") {
      const today = new Date().toISOString().slice(0, 10).replace(/-/g, "");
      const [active, days] = await Promise.all([
        this.api.request<number>("/stats/active-users").catch(() => undefined),
        this.api
          .request<A0DailyStat[]>("/stats/daily", { query: { from: today, to: today } })
          .catch(() => []),
      ]);
      return [
        { label: "Active users (30d)", value: active === undefined ? "—" : String(active) },
        { label: "Logins today", value: String(days?.[0]?.logins ?? 0) },
        { label: "Signups today", value: String(days?.[0]?.signups ?? 0) },
      ];
    }
    if (resourceTypeId === "organization") {
      const members = await this.api
        .request<{ total?: number }>(`/organizations/${id}/members`, {
          query: { per_page: 1, include_totals: true },
        })
        .catch(() => ({ total: undefined }));
      return [
        { label: "Members", value: members.total === undefined ? "—" : String(members.total) },
      ];
    }
    if (resourceTypeId === "role") {
      const users = await this.api
        .request<{ total?: number }>(`/roles/${id}/users`, {
          query: { per_page: 1, include_totals: true },
        })
        .catch(() => ({ total: undefined }));
      return [{ label: "Users", value: users.total === undefined ? "—" : String(users.total) }];
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
    const perPage = Math.min(Math.max(params.tailLines ?? 100, 1), 100);
    let logs: A0Log[];
    if (typeId === "user") {
      logs = await this.api.request<A0Log[]>(`/users/${encodeURIComponent(id)}/logs`, {
        query: { per_page: perPage, sort: "date:-1" },
      });
    } else {
      let q = "";
      if (typeId === "application") q = `client_id:"${id}"`;
      else if (typeId === "connection") q = `connection_id:"${id}"`;
      else if (typeId === "organization") q = `organization_id:"${id}"`;
      else if (typeId !== "tenant")
        throw new Error(
          "Auth0 plugin: logs are shown on the tenant, applications, connections, users and organizations",
        );
      logs = await this.api.request<A0Log[]>("/logs", {
        query: { per_page: perPage, sort: "date:-1", ...(q ? { q } : {}) },
      });
    }
    const lines = (logs ?? [])
      .slice()
      .reverse()
      .map((l) =>
        [
          logDate(l),
          str(l.type),
          LOG_TYPES[str(l.type)] ?? "",
          str(l.description),
          l.client_name ? `app=${l.client_name}` : "",
          l.connection ? `connection=${l.connection}` : "",
          l.user_name ? `user=${l.user_name}` : "",
          l.ip ? `ip=${l.ip}` : "",
        ]
          .filter(Boolean)
          .join(" "),
      );
    return {
      text: lines.map((l) => `${l}\n`).join(""),
      containers: ["tenant-logs"],
      activeContainer: "tenant-logs",
    };
  }

  // -------------------------------------------------------------------------
  // Attack protection (settings editor on the tenant)
  // -------------------------------------------------------------------------

  async getManifest(): Promise<string> {
    const [bf, bp, sit, flags] = await Promise.all([
      this.api.request<{ enabled?: boolean; max_attempts?: number; shields?: string[] }>(
        "/attack-protection/brute-force-protection",
      ),
      this.api.request<{ enabled?: boolean; shields?: string[] }>(
        "/attack-protection/breached-password-detection",
      ),
      this.api.request<{ enabled?: boolean }>("/attack-protection/suspicious-ip-throttling"),
      this.api.request<A0TenantSettings>("/tenants/settings"),
    ]);
    const tf = flags.flags ?? {};
    const settings: SettingDescriptor[] = [
      {
        id: "bf.enabled",
        label: "Brute-force protection",
        group: "Attack protection",
        control: "toggle",
        value: bf.enabled ? "on" : "off",
      },
      {
        id: "bf.max_attempts",
        label: "Failed attempts before blocking",
        group: "Attack protection",
        control: "number",
        value: str(bf.max_attempts ?? 10),
      },
      {
        id: "bp.enabled",
        label: "Breached password detection",
        group: "Attack protection",
        control: "toggle",
        value: bp.enabled ? "on" : "off",
      },
      {
        id: "sit.enabled",
        label: "Suspicious IP throttling",
        group: "Attack protection",
        control: "toggle",
        value: sit.enabled ? "on" : "off",
      },
      {
        id: "flags.enable_client_connections",
        label: "Enable new connections for all applications",
        group: "Tenant flags",
        control: "toggle",
        value: tf["enable_client_connections"] ? "on" : "off",
      },
      {
        id: "flags.disable_clickjack_protection_headers",
        label: "Disable clickjacking protection headers",
        group: "Tenant flags",
        control: "toggle",
        value: tf["disable_clickjack_protection_headers"] ? "on" : "off",
      },
      {
        id: "flags.enable_public_signup_user_exists_error",
        label: "Tell sign-up that the user already exists",
        group: "Tenant flags",
        control: "toggle",
        value: tf["enable_public_signup_user_exists_error"] ? "on" : "off",
      },
    ];
    return JSON.stringify({ settings });
  }

  async applyManifest(_resourceId: string, _accountId: string, manifest: string): Promise<void> {
    const changes = JSON.parse(manifest) as Array<{ id: string; value: string }>;
    const on = (v: string) => v === "on" || v === "true";
    const bf: Record<string, unknown> = {};
    const flags: Record<string, boolean> = {};
    for (const { id, value } of changes) {
      if (id === "bf.enabled") bf["enabled"] = on(value);
      else if (id === "bf.max_attempts") bf["max_attempts"] = Number(value);
      else if (id === "bp.enabled") {
        await this.api.request("/attack-protection/breached-password-detection", {
          method: "PATCH",
          body: { enabled: on(value) },
        });
      } else if (id === "sit.enabled") {
        await this.api.request("/attack-protection/suspicious-ip-throttling", {
          method: "PATCH",
          body: { enabled: on(value) },
        });
      } else if (id.startsWith("flags.")) flags[id.slice(6)] = on(value);
    }
    if (Object.keys(bf).length > 0) {
      await this.api.request("/attack-protection/brute-force-protection", {
        method: "PATCH",
        body: bf,
      });
    }
    if (Object.keys(flags).length > 0) {
      await this.api.request("/tenants/settings", { method: "PATCH", body: { flags } });
    }
  }

  // -------------------------------------------------------------------------
  // Create
  // -------------------------------------------------------------------------

  private async connectionOptions(strategy?: string): Promise<SelectOption[]> {
    const connections = await this.api
      .pages<A0Connection>("/connections", "connections", strategy ? { strategy } : {}, 3)
      .catch(() => [] as A0Connection[]);
    return connections.map((c) => ({
      id: str(c.name),
      label: str(c.display_name) || str(c.name),
      description: str(c.strategy),
    }));
  }

  async getCreateConfig(typeId: string): Promise<CreateResourceConfig> {
    switch (typeId) {
      case "application":
        return {
          fields: [
            { key: "name", label: "Name", kind: "text", required: true },
            {
              key: "appType",
              label: "Type",
              kind: "select",
              required: true,
              defaultValue: "regular_web",
              options: [
                { id: "regular_web", label: "Regular web application" },
                { id: "spa", label: "Single-page application" },
                { id: "native", label: "Native (mobile or desktop)" },
                { id: "non_interactive", label: "Machine to machine" },
              ],
            },
            { key: "description", label: "Description", kind: "text", required: false },
            {
              key: "callbacks",
              label: "Allowed callback URLs",
              kind: "string-list",
              required: false,
              addLabel: "+ Add URL",
              showWhen: { fieldKey: "appType", fieldValuesNot: ["non_interactive"] },
            },
            {
              key: "allowedLogoutUrls",
              label: "Allowed logout URLs",
              kind: "string-list",
              required: false,
              addLabel: "+ Add URL",
              showWhen: { fieldKey: "appType", fieldValuesNot: ["non_interactive"] },
            },
            {
              key: "webOrigins",
              label: "Allowed web origins",
              kind: "string-list",
              required: false,
              addLabel: "+ Add origin",
              showWhen: { fieldKey: "appType", fieldValue: "spa" },
            },
          ],
        };
      case "api":
        return {
          fields: [
            { key: "name", label: "Name", kind: "text", required: true },
            {
              key: "identifier",
              label: "Identifier (audience)",
              kind: "text",
              required: true,
              placeholder: "https://api.example.com",
              description: "A URI that names the API. It cannot be changed later.",
            },
            {
              key: "signingAlg",
              label: "Signing algorithm",
              kind: "select",
              required: true,
              defaultValue: "RS256",
              options: [
                { id: "RS256", label: "RS256 (asymmetric, recommended)" },
                { id: "PS256", label: "PS256" },
                { id: "HS256", label: "HS256 (shared secret)" },
              ],
            },
            {
              key: "scopes",
              label: "Permissions",
              kind: "string-list",
              required: false,
              addLabel: "+ Add permission",
              description: "Scopes such as read:invoices.",
            },
          ],
        };
      case "connection":
        return {
          fields: [
            {
              key: "name",
              label: "Name",
              kind: "text",
              required: true,
              placeholder: "Customers-DB",
              description: "Letters, digits and hyphens.",
            },
            {
              key: "strategy",
              label: "Type",
              kind: "select",
              required: true,
              defaultValue: "auth0",
              options: [{ id: "auth0", label: "Database (username and password)" }],
              description:
                "Social and enterprise connections need provider credentials; add those in the Auth0 dashboard.",
            },
            {
              key: "enabledClients",
              label: "Enable for applications",
              kind: "policy-picker",
              required: false,
              policies: await this.clientPolicies(),
            },
          ],
        };
      case "user":
        return {
          fields: [
            {
              key: "connection",
              label: "Database connection",
              kind: "select",
              required: true,
              options: await this.connectionOptions("auth0"),
            },
            { key: "email", label: "Email", kind: "text", required: true },
            { key: "password", label: "Password", kind: "password", required: true },
            { key: "name", label: "Name", kind: "text", required: false },
            {
              key: "emailVerified",
              label: "Email verified",
              kind: "select",
              required: false,
              defaultValue: "false",
              options: [
                { id: "false", label: "No, send a verification email" },
                { id: "true", label: "Yes, mark as verified" },
              ],
            },
          ],
        };
      case "role":
        return {
          fields: [
            { key: "name", label: "Name", kind: "text", required: true },
            { key: "description", label: "Description", kind: "text", required: false },
            {
              key: "permissions",
              label: "Permissions",
              kind: "policy-picker",
              required: false,
              policies: await this.permissionPolicies(),
            },
          ],
        };
      case "organization":
        return {
          fields: [
            {
              key: "name",
              label: "Name",
              kind: "text",
              required: true,
              placeholder: "acme",
              description: "Lowercase letters, digits, - and _.",
            },
            {
              key: "displayName",
              label: "Display name",
              kind: "text",
              required: false,
              placeholder: "Acme Inc.",
            },
            { key: "logoUrl", label: "Logo URL", kind: "text", required: false },
            {
              key: "connections",
              label: "Enabled connections",
              kind: "policy-picker",
              required: false,
              policies: (await this.connectionIdOptions()).map((c) => ({
                ...c,
                category: "Connections",
              })),
            },
          ],
        };
      case "action": {
        const triggers = await this.api
          .request<{ triggers?: A0Trigger[] }>("/actions/triggers")
          .catch(() => ({ triggers: [] }));
        const current = (triggers.triggers ?? []).filter(
          (t) => !t.status || t.status === "CURRENT",
        );
        return {
          fields: [
            { key: "name", label: "Name", kind: "text", required: true },
            {
              key: "trigger",
              label: "Trigger",
              kind: "select",
              required: true,
              options: current.map((t) => ({
                id: `${str(t.id)}@${str(t.version)}`,
                label: `${str(t.id)} (${str(t.version)})`,
              })),
              defaultValue: current.find((t) => t.id === "post-login")
                ? `post-login@${str(current.find((t) => t.id === "post-login")?.version)}`
                : "",
            },
            {
              key: "runtime",
              label: "Runtime",
              kind: "select",
              required: false,
              defaultValue: "node22",
              options: [
                { id: "node22", label: "Node 22" },
                { id: "node18", label: "Node 18" },
              ],
            },
            {
              key: "code",
              label: "Code",
              kind: "code",
              codeLanguage: "javascript",
              required: true,
              defaultValue: ACTION_TEMPLATE,
            },
          ],
        };
      }
      case "log-stream":
        return {
          fields: [
            { key: "name", label: "Name", kind: "text", required: true },
            {
              key: "type",
              label: "Destination",
              kind: "select",
              required: true,
              defaultValue: "http",
              options: [
                { id: "http", label: "Custom webhook (HTTP)" },
                { id: "datadog", label: "Datadog" },
                { id: "splunk", label: "Splunk" },
                { id: "sumo", label: "Sumo Logic" },
              ],
            },
            {
              key: "httpEndpoint",
              label: "Endpoint URL",
              kind: "text",
              required: false,
              showWhen: { fieldKey: "type", fieldValue: "http" },
            },
            {
              key: "httpAuthorization",
              label: "Authorization header value",
              kind: "password",
              required: false,
              showWhen: { fieldKey: "type", fieldValue: "http" },
            },
            {
              key: "httpContentFormat",
              label: "Format",
              kind: "select",
              required: false,
              defaultValue: "JSONLINES",
              options: [
                { id: "JSONLINES", label: "JSON lines" },
                { id: "JSONARRAY", label: "JSON array" },
                { id: "JSONOBJECT", label: "JSON object per request" },
              ],
              showWhen: { fieldKey: "type", fieldValue: "http" },
            },
            {
              key: "datadogApiKey",
              label: "Datadog API key",
              kind: "password",
              required: false,
              showWhen: { fieldKey: "type", fieldValue: "datadog" },
            },
            {
              key: "datadogRegion",
              label: "Datadog site",
              kind: "select",
              required: false,
              defaultValue: "us",
              options: [
                { id: "us", label: "US1" },
                { id: "us3", label: "US3" },
                { id: "us5", label: "US5" },
                { id: "eu", label: "EU" },
              ],
              showWhen: { fieldKey: "type", fieldValue: "datadog" },
            },
            {
              key: "splunkDomain",
              label: "Splunk host",
              kind: "text",
              required: false,
              showWhen: { fieldKey: "type", fieldValue: "splunk" },
            },
            {
              key: "splunkPort",
              label: "Splunk HEC port",
              kind: "text",
              required: false,
              defaultValue: "8088",
              showWhen: { fieldKey: "type", fieldValue: "splunk" },
            },
            {
              key: "splunkToken",
              label: "Splunk HEC token",
              kind: "password",
              required: false,
              showWhen: { fieldKey: "type", fieldValue: "splunk" },
            },
            {
              key: "sumoSourceAddress",
              label: "Sumo HTTP source URL",
              kind: "password",
              required: false,
              showWhen: { fieldKey: "type", fieldValue: "sumo" },
            },
          ],
        };
      case "custom-domain":
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
              key: "type",
              label: "Certificates",
              kind: "select",
              required: true,
              defaultValue: "auth0_managed_certs",
              options: [
                { id: "auth0_managed_certs", label: "Auth0-managed (Auth0 issues and renews)" },
                { id: "self_managed_certs", label: "Self-managed (behind my own proxy)" },
              ],
            },
          ],
        };
      default:
        throw new Error(`Auth0 plugin: cannot create resource type "${typeId}"`);
    }
  }

  private async clientPolicies(): Promise<PolicyOption[]> {
    const clients = await this.api
      .pages<A0Client>("/clients", "clients", { is_global: false }, 3)
      .catch(() => [] as A0Client[]);
    return clients.map((c) => ({
      id: str(c.client_id),
      label: str(c.name),
      category: str(c.app_type) || "application",
    }));
  }

  private async connectionIdOptions(): Promise<SelectOption[]> {
    const connections = await this.api
      .pages<A0Connection>("/connections", "connections", {}, 3)
      .catch(() => [] as A0Connection[]);
    return connections.map((c) => ({
      id: str(c.id),
      label: str(c.display_name) || str(c.name),
      description: str(c.strategy),
    }));
  }

  /** Every API permission, as `identifier|scope` ids. */
  async permissionPolicies(): Promise<PolicyOption[]> {
    const apis = await this.api
      .pages<A0ResourceServer>("/resource-servers", "resource_servers", {}, 3)
      .catch(() => [] as A0ResourceServer[]);
    return apis.flatMap((api) =>
      (api.scopes ?? []).map((scope) => ({
        id: `${str(api.identifier)}|${str(scope.value)}`,
        label: str(scope.value),
        ...(scope.description ? { description: str(scope.description) } : {}),
        category: str(api.name) || str(api.identifier),
      })),
    );
  }

  private permissionsBody(ids: string[]) {
    return {
      permissions: ids.map((id) => {
        const bar = id.lastIndexOf("|");
        return { resource_server_identifier: id.slice(0, bar), permission_name: id.slice(bar + 1) };
      }),
    };
  }

  async createResource(
    typeId: string,
    accountId: string,
    fields: Record<string, string>,
  ): Promise<ResourceInstance> {
    switch (typeId) {
      case "application": {
        const appType = fields["appType"] || "regular_web";
        const client = await this.api.request<A0Client>("/clients", {
          method: "POST",
          body: {
            name: fields["name"],
            app_type: appType,
            ...(fields["description"] ? { description: fields["description"] } : {}),
            ...(list(fields["callbacks"]).length ? { callbacks: list(fields["callbacks"]) } : {}),
            ...(list(fields["allowedLogoutUrls"]).length
              ? { allowed_logout_urls: list(fields["allowedLogoutUrls"]) }
              : {}),
            ...(list(fields["webOrigins"]).length
              ? { web_origins: list(fields["webOrigins"]) }
              : {}),
            ...(appType === "spa" ? { token_endpoint_auth_method: "none" } : {}),
            oidc_conformant: true,
          },
        });
        return this.mapClient(accountId, client);
      }
      case "api": {
        const server = await this.api.request<A0ResourceServer>("/resource-servers", {
          method: "POST",
          body: {
            name: fields["name"],
            identifier: fields["identifier"],
            signing_alg: fields["signingAlg"] || "RS256",
            scopes: list(fields["scopes"]).map((value) => ({ value, description: value })),
          },
        });
        return this.mapApi(accountId, server);
      }
      case "connection": {
        const connection = await this.api.request<A0Connection>("/connections", {
          method: "POST",
          body: { name: fields["name"], strategy: fields["strategy"] || "auth0" },
        });
        const clients = list(fields["enabledClients"]);
        if (clients.length > 0) {
          await this.api.request(`/connections/${encodeURIComponent(str(connection.id))}/clients`, {
            method: "PATCH",
            body: clients.map((client_id) => ({ client_id, status: true })),
          });
        }
        return this.mapConnection(accountId, connection);
      }
      case "user": {
        const verified = fields["emailVerified"] === "true";
        const user = await this.api.request<A0User>("/users", {
          method: "POST",
          body: {
            connection: fields["connection"],
            email: fields["email"],
            password: fields["password"],
            ...(fields["name"] ? { name: fields["name"] } : {}),
            email_verified: verified,
            verify_email: !verified,
          },
        });
        return this.mapUser(accountId, user);
      }
      case "role": {
        const role = await this.api.request<A0Role>("/roles", {
          method: "POST",
          body: {
            name: fields["name"],
            ...(fields["description"] ? { description: fields["description"] } : {}),
          },
        });
        const permissions = list(fields["permissions"]);
        if (permissions.length > 0) {
          await this.api.request(`/roles/${encodeURIComponent(str(role.id))}/permissions`, {
            method: "POST",
            body: this.permissionsBody(permissions),
          });
        }
        return this.mapRole(
          accountId,
          role,
          permissions.map((p) => p.replace("|", ":")),
        );
      }
      case "organization": {
        const org = await this.api.request<A0Organization>("/organizations", {
          method: "POST",
          body: {
            name: fields["name"],
            ...(fields["displayName"] ? { display_name: fields["displayName"] } : {}),
            ...(fields["logoUrl"] ? { branding: { logo_url: fields["logoUrl"] } } : {}),
            ...(list(fields["connections"]).length
              ? {
                  enabled_connections: list(fields["connections"]).map((connection_id) => ({
                    connection_id,
                  })),
                }
              : {}),
          },
        });
        return this.mapOrganization(accountId, org);
      }
      case "action": {
        const [id, version] = (fields["trigger"] || "post-login@v3").split("@");
        const action = await this.api.request<A0Action>("/actions/actions", {
          method: "POST",
          body: {
            name: fields["name"],
            supported_triggers: [{ id, version }],
            code: fields["code"] || ACTION_TEMPLATE,
            runtime: fields["runtime"] || "node22",
          },
        });
        return this.mapAction(accountId, action, new Set());
      }
      case "log-stream": {
        const type = fields["type"] || "http";
        const sinks: Record<string, Record<string, unknown>> = {
          http: {
            httpEndpoint: fields["httpEndpoint"],
            httpContentType: "application/json",
            httpContentFormat: fields["httpContentFormat"] || "JSONLINES",
            ...(fields["httpAuthorization"]
              ? { httpAuthorization: fields["httpAuthorization"] }
              : {}),
          },
          datadog: {
            datadogApiKey: fields["datadogApiKey"],
            datadogRegion: fields["datadogRegion"] || "us",
          },
          splunk: {
            splunkDomain: fields["splunkDomain"],
            splunkPort: fields["splunkPort"] || "8088",
            splunkToken: fields["splunkToken"],
            splunkSecure: true,
          },
          sumo: { sumoSourceAddress: fields["sumoSourceAddress"] },
        };
        const sink = sinks[type];
        if (!sink) throw new Error(`Auth0 plugin: unsupported log stream type "${type}"`);
        const stream = await this.api.request<A0LogStream>("/log-streams", {
          method: "POST",
          body: { name: fields["name"], type, sink },
        });
        return this.mapLogStream(accountId, stream);
      }
      case "custom-domain": {
        const domain = await this.api.request<A0CustomDomain>("/custom-domains", {
          method: "POST",
          body: { domain: fields["domain"], type: fields["type"] || "auth0_managed_certs" },
        });
        return this.mapCustomDomain(accountId, domain);
      }
      default:
        throw new Error(`Auth0 plugin: cannot create resource type "${typeId}"`);
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
    const has = (key: string) => fields[key] !== undefined;
    switch (typeId) {
      case "tenant": {
        const settings: Record<string, unknown> = {};
        const map: Array<[string, string]> = [
          ["friendlyName", "friendly_name"],
          ["supportEmail", "support_email"],
          ["supportUrl", "support_url"],
          ["pictureUrl", "picture_url"],
          ["defaultAudience", "default_audience"],
          ["defaultDirectory", "default_directory"],
        ];
        for (const [key, api] of map) if (has(key)) settings[api] = fields[key];
        if (fields["sessionLifetime"])
          settings["session_lifetime"] = Number(fields["sessionLifetime"]);
        if (fields["idleSessionLifetime"])
          settings["idle_session_lifetime"] = Number(fields["idleSessionLifetime"]);
        if (has("enabledLocales")) settings["enabled_locales"] = list(fields["enabledLocales"]);
        if (Object.keys(settings).length > 0)
          await this.api.request("/tenants/settings", { method: "PATCH", body: settings });
        const branding: Record<string, unknown> = {};
        const colors: Record<string, string> = {};
        if (fields["brandPrimaryColor"]) colors["primary"] = fields["brandPrimaryColor"];
        if (fields["brandBackgroundColor"])
          colors["page_background"] = fields["brandBackgroundColor"];
        if (Object.keys(colors).length > 0) branding["colors"] = colors;
        if (has("brandLogoUrl")) branding["logo_url"] = fields["brandLogoUrl"];
        if (has("brandFaviconUrl")) branding["favicon_url"] = fields["brandFaviconUrl"];
        if (Object.keys(branding).length > 0)
          await this.api.request("/branding", { method: "PATCH", body: branding });
        return this.tenantResource(accountId);
      }
      case "application": {
        const body: Record<string, unknown> = {};
        if (has("name")) body["name"] = fields["name"];
        if (has("description")) body["description"] = fields["description"];
        if (has("callbacks")) body["callbacks"] = list(fields["callbacks"]);
        if (has("allowedLogoutUrls"))
          body["allowed_logout_urls"] = list(fields["allowedLogoutUrls"]);
        if (has("webOrigins")) body["web_origins"] = list(fields["webOrigins"]);
        if (has("allowedOrigins")) body["allowed_origins"] = list(fields["allowedOrigins"]);
        if (has("initiateLoginUri")) body["initiate_login_uri"] = fields["initiateLoginUri"];
        if (has("logoUri")) body["logo_uri"] = fields["logoUri"];
        return this.mapClient(
          accountId,
          await this.api.request<A0Client>(`/clients/${id}`, { method: "PATCH", body }),
        );
      }
      case "api": {
        const body: Record<string, unknown> = {};
        if (has("name")) body["name"] = fields["name"];
        if (fields["signingAlg"]) body["signing_alg"] = fields["signingAlg"];
        if (fields["tokenLifetime"]) body["token_lifetime"] = Number(fields["tokenLifetime"]);
        if (fields["tokenLifetimeForWeb"])
          body["token_lifetime_for_web"] = Number(fields["tokenLifetimeForWeb"]);
        for (const [key, api] of [
          ["allowOfflineAccess", "allow_offline_access"],
          ["skipConsent", "skip_consent_for_verifiable_first_party_clients"],
          ["enforcePolicies", "enforce_policies"],
        ] as const) {
          const value = bool(fields[key]);
          if (value !== undefined) body[api] = value;
        }
        if (fields["tokenDialect"]) body["token_dialect"] = fields["tokenDialect"];
        return this.mapApi(
          accountId,
          await this.api.request<A0ResourceServer>(`/resource-servers/${id}`, {
            method: "PATCH",
            body,
          }),
        );
      }
      case "connection": {
        const body: Record<string, unknown> = {};
        if (has("displayName")) body["display_name"] = fields["displayName"];
        const domain = bool(fields["isDomainConnection"]);
        if (domain !== undefined) body["is_domain_connection"] = domain;
        const button = bool(fields["showAsButton"]);
        if (button !== undefined) body["show_as_button"] = button;
        return this.mapConnection(
          accountId,
          await this.api.request<A0Connection>(`/connections/${id}`, { method: "PATCH", body }),
        );
      }
      case "user": {
        const body: Record<string, unknown> = {};
        for (const key of ["email", "name", "nickname"]) if (has(key)) body[key] = fields[key];
        const verified = bool(fields["emailVerified"]);
        if (verified !== undefined) body["email_verified"] = verified;
        const blocked = bool(fields["blocked"]);
        if (blocked !== undefined) body["blocked"] = blocked;
        return this.mapUser(
          accountId,
          await this.api.request<A0User>(`/users/${id}`, { method: "PATCH", body }),
        );
      }
      case "role": {
        const body: Record<string, unknown> = {};
        if (has("name")) body["name"] = fields["name"];
        if (has("description")) body["description"] = fields["description"];
        await this.api.request(`/roles/${id}`, { method: "PATCH", body });
        return this.getResource(typeId, resourceId, accountId);
      }
      case "organization": {
        const current = await this.api.request<A0Organization>(`/organizations/${id}`);
        const body: Record<string, unknown> = {};
        if (has("name")) body["name"] = fields["name"];
        if (has("displayName")) body["display_name"] = fields["displayName"];
        if (has("logoUrl") || has("primaryColor") || has("backgroundColor")) {
          const branding = { ...(current.branding ?? {}) } as Record<string, unknown>;
          const colors = {
            ...((current.branding?.colors as Record<string, unknown> | undefined) ?? {}),
          };
          if (has("logoUrl")) branding["logo_url"] = fields["logoUrl"];
          if (fields["primaryColor"]) colors["primary"] = fields["primaryColor"];
          if (fields["backgroundColor"]) colors["page_background"] = fields["backgroundColor"];
          if (colors["primary"] && colors["page_background"]) branding["colors"] = colors;
          body["branding"] = branding;
        }
        return this.mapOrganization(
          accountId,
          await this.api.request<A0Organization>(`/organizations/${id}`, { method: "PATCH", body }),
        );
      }
      case "action": {
        const body: Record<string, unknown> = {};
        if (has("name")) body["name"] = fields["name"];
        if (fields["runtime"]) body["runtime"] = fields["runtime"];
        await this.api.request(`/actions/actions/${id}`, { method: "PATCH", body });
        return this.getResource(typeId, resourceId, accountId);
      }
      case "log-stream": {
        const body: Record<string, unknown> = {};
        if (has("name")) body["name"] = fields["name"];
        if (fields["status"]) body["status"] = fields["status"];
        return this.mapLogStream(
          accountId,
          await this.api.request<A0LogStream>(`/log-streams/${id}`, { method: "PATCH", body }),
        );
      }
      case "custom-domain": {
        const body: Record<string, unknown> = {};
        if (fields["tlsPolicy"]) body["tls_policy"] = fields["tlsPolicy"];
        if (has("customClientIpHeader"))
          body["custom_client_ip_header"] = fields["customClientIpHeader"];
        return this.mapCustomDomain(
          accountId,
          await this.api.request<A0CustomDomain>(`/custom-domains/${id}`, {
            method: "PATCH",
            body,
          }),
        );
      }
      default:
        throw new Error(`Auth0 plugin: cannot update resource type "${typeId}"`);
    }
  }

  async deleteResource(typeId: string, resourceId: string): Promise<void> {
    const id = encodeURIComponent(externalIdOf(resourceId));
    const paths: Record<string, string> = {
      application: `/clients/${id}`,
      api: `/resource-servers/${id}`,
      connection: `/connections/${id}`,
      user: `/users/${id}`,
      role: `/roles/${id}`,
      organization: `/organizations/${id}`,
      action: `/actions/actions/${id}`,
      "log-stream": `/log-streams/${id}`,
      "custom-domain": `/custom-domains/${id}`,
    };
    const path = paths[typeId];
    if (!path) throw new Error(`Auth0 plugin: cannot delete resource type "${typeId}"`);
    // Actions still bound into a flow need `force` to delete.
    await this.api.request(path, {
      method: "DELETE",
      ...(typeId === "action" ? { query: { force: true } } : {}),
    });
  }

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  async invokeAction(typeId: string, resourceId: string, actionId: string): Promise<void> {
    const raw = externalIdOf(resourceId);
    const id = encodeURIComponent(raw);
    switch (`${typeId}:${actionId}`) {
      case "application:rotate-secret":
        await this.api.request(`/clients/${id}/rotate-secret`, { method: "POST" });
        return;
      case "user:block":
      case "user:unblock":
        await this.api.request(`/users/${id}`, {
          method: "PATCH",
          body: { blocked: actionId === "block" },
        });
        return;
      case "user:send-verification":
        await this.api.request("/jobs/verification-email", {
          method: "POST",
          body: { user_id: raw },
        });
        return;
      case "user:reset-mfa":
        await this.api.request(`/users/${id}/authentication-methods`, { method: "DELETE" });
        return;
      case "action:deploy":
        await this.api.request(`/actions/actions/${id}/deploy`, { method: "POST" });
        return;
      case "action:bind": {
        const action = await this.api.request<A0Action>(`/actions/actions/${id}`);
        const trigger = str(action.supported_triggers?.[0]?.id);
        if (!trigger) throw new Error("Auth0 plugin: the action has no trigger");
        const current = await this.api.request<{ bindings?: A0Binding[] }>(
          `/actions/triggers/${encodeURIComponent(trigger)}/bindings`,
        );
        const bindings = (current.bindings ?? []).map((b) => ({
          ref: { type: "binding_id", value: str(b.id) },
          display_name: str(b.display_name),
        }));
        if ((current.bindings ?? []).some((b) => b.action?.id === raw)) return;
        bindings.push({ ref: { type: "action_id", value: raw }, display_name: str(action.name) });
        await this.api.request(`/actions/triggers/${encodeURIComponent(trigger)}/bindings`, {
          method: "PATCH",
          body: { bindings },
        });
        return;
      }
      case "action:unbind": {
        const action = await this.api.request<A0Action>(`/actions/actions/${id}`);
        const trigger = str(action.supported_triggers?.[0]?.id);
        const current = await this.api.request<{ bindings?: A0Binding[] }>(
          `/actions/triggers/${encodeURIComponent(trigger)}/bindings`,
        );
        const bindings = (current.bindings ?? [])
          .filter((b) => b.action?.id !== raw)
          .map((b) => ({
            ref: { type: "binding_id", value: str(b.id) },
            display_name: str(b.display_name),
          }));
        await this.api.request(`/actions/triggers/${encodeURIComponent(trigger)}/bindings`, {
          method: "PATCH",
          body: { bindings },
        });
        return;
      }
      case "custom-domain:verify":
        await this.api.request(`/custom-domains/${id}/verify`, { method: "POST" });
        return;
      case "log-stream:pause":
      case "log-stream:resume":
        await this.api.request(`/log-streams/${id}`, {
          method: "PATCH",
          body: { status: actionId === "pause" ? "paused" : "active" },
        });
        return;
      default:
        throw new Error(`Auth0 plugin: unknown action "${actionId}" for type "${typeId}"`);
    }
  }

  async executeNoSqlCommand(
    typeId: string,
    resourceId: string,
    _accountId: string,
    command: string,
    args: (string | number)[],
  ): Promise<unknown> {
    const values = JSON.parse(String(args[0] ?? "{}")) as Record<string, string>;
    const raw = externalIdOf(resourceId);
    const id = encodeURIComponent(raw);
    const need = (key: string, what: string): string => {
      const value = values[key];
      if (!value) throw new Error(`Auth0 plugin: choose ${what}`);
      return value;
    };
    switch (`${typeId}:${command}`) {
      case "action:edit-code": {
        await this.api.request(`/actions/actions/${id}`, {
          method: "PATCH",
          body: { code: values["code"] ?? "" },
        });
        if (values["deploy"] === "true")
          await this.api.request(`/actions/actions/${id}/deploy`, { method: "POST" });
        return { ok: true };
      }
      case "api:set-scopes": {
        const scopes = list(values["scopes"]).map((value) => ({ value, description: value }));
        return this.api.request(`/resource-servers/${id}`, { method: "PATCH", body: { scopes } });
      }
      case "role:add-permissions":
        return this.api.request(`/roles/${id}/permissions`, {
          method: "POST",
          body: this.permissionsBody(list(values["permissions"])),
        });
      case "role:remove-permissions":
        return this.api.request(`/roles/${id}/permissions`, {
          method: "DELETE",
          body: this.permissionsBody(list(values["permissions"])),
        });
      case "user:assign-roles":
        return this.api.request(`/users/${id}/roles`, {
          method: "POST",
          body: { roles: list(values["roles"]) },
        });
      case "user:remove-roles":
        return this.api.request(`/users/${id}/roles`, {
          method: "DELETE",
          body: { roles: list(values["roles"]) },
        });
      case "connection:enable-clients":
      case "connection:disable-clients":
        return this.api.request(`/connections/${id}/clients`, {
          method: "PATCH",
          body: list(values["clients"]).map((client_id) => ({
            client_id,
            status: command === "enable-clients",
          })),
        });
      case "organization:add-members":
        return this.api.request(`/organizations/${id}/members`, {
          method: "POST",
          body: { members: list(values["users"]) },
        });
      case "organization:remove-members":
        return this.api.request(`/organizations/${id}/members`, {
          method: "DELETE",
          body: { members: list(values["users"]) },
        });
      case "organization:enable-connection":
        return this.api.request(`/organizations/${id}/enabled_connections`, {
          method: "POST",
          body: {
            connection_id: need("connectionId", "a connection"),
            assign_membership_on_login: values["autoMembership"] === "true",
          },
        });
      case "organization:disable-connection":
        return this.api.request(
          `/organizations/${id}/enabled_connections/${encodeURIComponent(need("connectionId", "a connection"))}`,
          {
            method: "DELETE",
          },
        );
      case "organization:invite": {
        const clientId = need("clientId", "an application");
        return this.api.request(`/organizations/${id}/invitations`, {
          method: "POST",
          body: {
            inviter: { name: values["inviter"] || "Infrawrench" },
            invitee: { email: need("email", "an email address") },
            client_id: clientId,
            send_invitation_email: true,
            ...(values["roles"] ? { roles: list(values["roles"]) } : {}),
          },
        });
      }
      default:
        throw new Error(`Auth0 plugin: unknown command "${command}" for type "${typeId}"`);
    }
  }

  async exportCredential(
    typeId: string,
    resourceId: string,
    _accountId: string,
    formatId: string,
  ): Promise<CredentialExport> {
    if (typeId === "user" && formatId === "password-reset-link") {
      const body = await this.api.request<{ ticket?: string }>("/tickets/password-change", {
        method: "POST",
        body: { user_id: externalIdOf(resourceId), ttl_sec: 86400 },
      });
      const ticket = str(body.ticket);
      if (!ticket) throw new Error("Auth0 plugin: Auth0 returned no ticket");
      return {
        content: ticket,
        filename: "password-reset-link.txt",
        mimeType: "text/plain",
        fields: [
          {
            label: "Password reset link",
            value: ticket,
            sensitive: true,
            hint: "Valid for 24 hours",
          },
        ],
        warning: "Anyone with this link can set the user's password until it is used or expires.",
      };
    }
    throw new Error(`Auth0 plugin: unknown credential format "${formatId}"`);
  }

  // -------------------------------------------------------------------------
  // Detail enrichment + rendering
  // -------------------------------------------------------------------------

  async enrichDetail(resource: ResourceInstance): Promise<ResourceInstance> {
    const raw = externalIdOf(resource.id);
    const id = encodeURIComponent(raw);
    const extra: Record<string, string> = {};
    switch (resource.resourceTypeId) {
      case "user": {
        const [roles, allRoles] = await Promise.all([
          this.api.pages<A0Role>(`/users/${id}/roles`, "roles", {}, 2).catch(() => [] as A0Role[]),
          this.api.pages<A0Role>("/roles", "roles", {}, 3).catch(() => [] as A0Role[]),
        ]);
        extra["__roles__"] = JSON.stringify(
          roles.map((r) => ({ id: str(r.id), label: str(r.name) })),
        );
        extra["__roleOptions__"] = JSON.stringify(
          allRoles.map((r) => ({
            id: str(r.id),
            label: str(r.name),
            description: str(r.description),
          })),
        );
        break;
      }
      case "role": {
        const [granted, all] = await Promise.all([
          this.rolePermissions(raw).catch(() => []),
          this.permissionPolicies(),
        ]);
        extra["__granted__"] = JSON.stringify(
          granted.map((p) => `${str(p.resource_server_identifier)}|${str(p.permission_name)}`),
        );
        extra["__permissionOptions__"] = JSON.stringify(all);
        break;
      }
      case "connection": {
        const [enabled, clients, status] = await Promise.all([
          this.api
            .request<{ clients?: Array<{ client_id?: string }> }>(`/connections/${id}/clients`)
            .then((b) => (b.clients ?? []).map((c) => str(c.client_id)))
            .catch(() => [] as string[]),
          this.clientPolicies(),
          this.api
            .call<unknown>(`/connections/${id}/status`)
            .then(() => "online")
            .catch((e: { status?: number }) => (e.status === 404 ? "" : "offline")),
        ]);
        extra["__enabledClients__"] = JSON.stringify(enabled);
        extra["__clientOptions__"] = JSON.stringify(
          clients.map((c) => ({ id: c.id, label: c.label })),
        );
        extra["__status__"] = status;
        break;
      }
      case "organization": {
        const [members, users, connections, enabled, clients] = await Promise.all([
          this.api
            .pages<{ user_id?: string; email?: string; name?: string }>(
              `/organizations/${id}/members`,
              "members",
              {},
              2,
            )
            .catch(() => []),
          this.api.pages<A0User>("/users", "users", {}, 2).catch(() => [] as A0User[]),
          this.connectionIdOptions(),
          this.api
            .pages<{ connection_id?: string; connection?: { name?: string } }>(
              `/organizations/${id}/enabled_connections`,
              "enabled_connections",
              {},
              2,
            )
            .catch(() => []),
          this.clientPolicies(),
        ]);
        extra["__members__"] = JSON.stringify(
          members.map((m) => ({
            id: str(m.user_id),
            label: str(m.email) || str(m.name) || str(m.user_id),
          })),
        );
        extra["__userOptions__"] = JSON.stringify(
          users.map((u) => ({ id: str(u.user_id), label: str(u.email) || str(u.user_id) })),
        );
        extra["__connectionOptions__"] = JSON.stringify(connections);
        extra["__enabledConnections__"] = JSON.stringify(
          enabled.map((c) => ({
            id: str(c.connection_id),
            label: str(c.connection?.name) || str(c.connection_id),
          })),
        );
        extra["__clientOptions__"] = JSON.stringify(
          clients.map((c) => ({ id: c.id, label: c.label })),
        );
        break;
      }
      default:
        return resource;
    }
    return { ...resource, resolvedOutputs: { ...resource.resolvedOutputs, ...extra } };
  }

  renderDetail(resource: ResourceInstance): DetailViewSchema {
    return renderDetail(resource, this.api.domain);
  }

  renderSidebarItem(resource: ResourceInstance): SidebarItemSchema {
    return renderSidebarItem(resource);
  }
}
