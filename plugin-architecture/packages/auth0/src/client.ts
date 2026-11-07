import type { Credentials } from "./plugin.js";
import { attempt, runPluginEffect } from "@infrawrench/plugin-base/effect";
import type { ApiBody, ApiClient, ApiResponse, PluginEffect } from "@infrawrench/plugin-base";
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
import { externalIdOf, pathEncode, rethrowIncompleteList } from "@infrawrench/plugin-base";
import type { operations, paths } from "./api-types.gen.js";
import { Auth0Api, checkpoints, pages, readCredentials, regionOfDomain, walkPages } from "./api.js";
import { renderDetail, renderSidebarItem } from "./render.js";
import { usersPastSearch, type ExportedUser } from "./user-export.js";
import type {
  A0Action,
  A0Branding,
  A0Client,
  A0Connection,
  A0CustomDomain,
  A0EnabledClient,
  A0Log,
  A0LogStream,
  A0Organization,
  A0ResourceServer,
  A0Role,
  A0TenantSettings,
  A0User,
} from "./types.js";

const PLUGIN_ID = "auth0";
export const METRICS_DEFAULT_RANGE_MS = 30 * 24 * 60 * 60 * 1000;

/** What a picker or a detail view reads: part of a list is fine, and nothing is stored from it. */
const PICKER = { maxPages: 10, partial: true };

const MAX_ENABLED_CLIENT_READS = 1000;

/** All of the 1,000 users Auth0's search returns of a query, at 100 a page. */
const USER_SEARCH_PAGES = 10;

/** 10,000 custom domains at the 100 a page the document allows. */
const MAX_CUSTOM_DOMAIN_PAGES = 100;

/** Starter code for a new Action, per trigger family. */
const ACTION_TEMPLATE = `/**
 * Handler that will be called during the execution of the flow.
 * @param {Event} event - Details about the context of the call.
 * @param {API} api - Methods that change the behavior of the flow.
 */
exports.onExecutePostLogin = async (event, api) => {
};
`;

/** Whatever a response field turned out to hold: responses are not validated. */
type Loose = string | number | boolean | object | null | undefined;

function str(value: Loose): string {
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

type ActionBindingUpdate = NonNullable<ApiBody<operations["patch_bindings"]>["bindings"]>[number];

export class Auth0Client implements PluginClient {
  readonly api: Auth0Api;
  private readonly rest: ApiClient<paths>;

  constructor(
    credentials: Credentials,
    private readonly services?: HostServices,
  ) {
    this.api = new Auth0Api(readCredentials(credentials), services);
    this.rest = this.api.rest;
  }

  // -------------------------------------------------------------------------
  // Listing
  // -------------------------------------------------------------------------

  listResources(typeId: string, accountId: string): PluginEffect<ResourceInstance[]> {
    return attempt(async () => {
      switch (typeId) {
        case "tenant":
          return [await this.tenantResource(accountId)];
        case "application":
          return (
            await pages("/clients", "clients", (paging) =>
              this.rest.get("/clients", { query: { is_global: false, ...paging } }),
            )
          ).map((c) => this.mapClient(accountId, c));
        case "api":
          return (
            await pages("/resource-servers", "resource_servers", (paging) =>
              this.rest.get("/resource-servers", { query: paging }),
            )
          ).map((r) => this.mapApi(accountId, r));
        case "connection": {
          const connections = await checkpoints<"connections", A0Connection>(
            "/connections",
            "connections",
            (query) => this.rest.get("/connections", { query }),
          );
          const enabled = await this.enabledClientsOfRows(connections);
          return connections.map((c) =>
            this.mapConnection(accountId, c, enabled.get(str(c.id)) ?? c.enabled_clients),
          );
        }
        case "user":
          return (await this.listUsers(accountId)).map((u) => this.mapUser(accountId, u));
        case "role":
          return (
            await pages("/roles", "roles", (paging) => this.rest.get("/roles", { query: paging }))
          ).map((r) => this.mapRole(accountId, r));
        case "organization":
          return (
            await checkpoints("/organizations", "organizations", (query) =>
              this.rest.get("/organizations", { query }),
            )
          ).map((o) => this.mapOrganization(accountId, o));
        case "action": {
          const [actions, bound] = await Promise.all([
            pages("/actions/actions", "actions", (paging) =>
              this.rest.get("/actions/actions", { query: paging }),
            ),
            this.boundActionIds(),
          ]);
          return actions.map((a) => this.mapAction(accountId, a, bound));
        }
        case "log-stream":
          return (await this.rest.get("/log-streams")).map((s) => this.mapLogStream(accountId, s));
        case "custom-domain":
          return (
            await checkpoints(
              "/custom-domains",
              "custom_domains",
              (query) => this.rest.get("/custom-domains", { query }),
              { maxPages: MAX_CUSTOM_DOMAIN_PAGES },
            )
          ).map((d) => this.mapCustomDomain(accountId, d));
        default:
          throw new Error(`Auth0 plugin: unknown resource type "${typeId}"`);
      }
    });
  }

  /**
   * The search alone for a tenant it can read whole, which is nearly all of them and
   * spends no job. Its newest rows also keep a larger tenant fresh between exports.
   */
  private async listUsers(accountId: string): Promise<(A0User | ExportedUser)[]> {
    const { rows, cut } = await walkPages(
      "/users",
      "users",
      (paging) => this.rest.get("/users", { query: { sort: "created_at:-1", ...paging } }),
      // A best-effort search, as the document says, with nothing to say `total` counts
      // past the depth it pages to. Only a short page proves the end, so a tenant of
      // exactly 1,000 takes the export, which is right for it too.
      { maxPages: USER_SEARCH_PAGES, totalIsEstimate: true },
    );
    if (!cut) return rows;
    return usersPastSearch(
      {
        rest: this.rest,
        services: this.services,
        caCert: this.api.creds.caCert,
        stateResourceId: `${accountId}:tenant:${this.api.domain}`,
      },
      rows,
    );
  }

  getResource(
    typeId: string,
    resourceId: string,
    accountId: string,
  ): PluginEffect<ResourceInstance> {
    return attempt(async () => {
      const id = pathEncode(externalIdOf(resourceId));
      switch (typeId) {
        case "tenant":
          return this.tenantResource(accountId);
        case "application":
          return this.mapClient(accountId, await this.rest.get(`/clients/${id}`));
        case "api":
          return this.mapApi(accountId, await this.rest.get(`/resource-servers/${id}`));
        case "connection":
          return this.mapReadConnection(accountId, await this.rest.get(`/connections/${id}`));
        case "user":
          return this.mapUser(accountId, await this.rest.get(`/users/${id}`));
        case "role": {
          const [role, permissions] = await Promise.all([
            this.rest.get(`/roles/${id}`),
            this.rolePermissions(externalIdOf(resourceId)).catch((err) => {
              rethrowIncompleteList(err);
              return [];
            }),
          ]);
          return this.mapRole(
            accountId,
            role,
            permissions.map((p) => `${p.resource_server_identifier}:${p.permission_name}`),
          );
        }
        case "organization":
          return this.mapOrganization(accountId, await this.rest.get(`/organizations/${id}`));
        case "action": {
          const [action, bound] = await Promise.all([
            this.rest.get(`/actions/actions/${id}`),
            this.boundActionIds(),
          ]);
          return this.mapAction(accountId, action, bound);
        }
        case "log-stream":
          return this.mapLogStream(accountId, await this.rest.get(`/log-streams/${id}`));
        case "custom-domain":
          return this.mapCustomDomain(accountId, await this.rest.get(`/custom-domains/${id}`));
        default:
          throw new Error(`Auth0 plugin: unknown resource type "${typeId}"`);
      }
    });
  }

  resolveOutput(
    typeId: string,
    resourceId: string,
    outputKey: string,
    accountId: string,
  ): PluginEffect<string> {
    return attempt(async () => {
      if (typeId === "application" && outputKey === "clientSecret") {
        const client = await this.rest.get(`/clients/${pathEncode(externalIdOf(resourceId))}`, {
          query: { fields: "client_secret", include_fields: true },
        });
        if (!client.client_secret)
          throw new Error("Auth0 plugin: this application has no client secret");
        return client.client_secret;
      }
      const resource = await runPluginEffect(this.getResource(typeId, resourceId, accountId));
      const value = resource.resolvedOutputs[outputKey];
      if (value !== undefined && value !== "") return value;
      throw new Error(`Auth0 plugin: cannot resolve output "${outputKey}" for type "${typeId}"`);
    });
  }

  rerollOutput(typeId: string, resourceId: string, outputKey: string): PluginEffect<void> {
    return attempt(async () => {
      if (typeId === "application" && outputKey === "clientSecret") {
        await this.rest.post(`/clients/${pathEncode(externalIdOf(resourceId))}/rotate-secret`);
        return;
      }
      throw new Error(`Auth0 plugin: cannot reissue "${outputKey}"`);
    });
  }

  /**
   * For the list rows that carry no `enabled_clients`, as the document says they do not.
   * One request per connection per sync, for a plain field: past
   * {@link MAX_ENABLED_CLIENT_READS} rows it stays blank, which is not worth failing the
   * inventory over, and a row whose read fails stays blank too.
   */
  private async enabledClientsOfRows(rows: A0Connection[]): Promise<Map<string, string[]>> {
    const out = new Map<string, string[]>();
    const ids = rows.filter((c) => !c.enabled_clients && c.id).map((c) => str(c.id));
    if (ids.length > MAX_ENABLED_CLIENT_READS) return out;
    for (const id of ids) {
      const enabled = await this.enabledClientIds(id).catch((err) => {
        rethrowIncompleteList(err);
        return undefined;
      });
      if (enabled) out.set(id, enabled);
    }
    return out;
  }

  /** A connection from a single read or write, whose `enabled_clients` is deprecated. */
  private async mapReadConnection(accountId: string, c: A0Connection): Promise<ResourceInstance> {
    const enabled = c.id
      ? await this.enabledClientIds(c.id).catch(() => c.enabled_clients)
      : c.enabled_clients;
    return this.mapConnection(accountId, c, enabled);
  }

  /** The applications a connection is enabled for, at the route's largest page. */
  private async enabledClientIds(connectionId: string): Promise<string[]> {
    const path = `/connections/${pathEncode(connectionId)}/clients` as const;
    const clients = await checkpoints<"clients", A0EnabledClient>(
      path,
      "clients",
      (query) => this.rest.get(path, { query }),
      { take: 1000, maxPages: 10 },
    );
    return clients.map((c) => str(c.client_id));
  }

  private async rolePermissions(roleId: string) {
    const path = `/roles/${pathEncode(roleId)}/permissions` as const;
    return pages(path, "permissions", (paging) => this.rest.get(path, { query: paging }));
  }

  private actionTriggers() {
    return this.rest
      .get("/actions/triggers")
      .catch((): ApiResponse<operations["get_triggers"]> => ({ triggers: [] }));
  }

  /**
   * Every binding of a flow. A bind or an unbind replaces the whole list with what this
   * read, so a binding missing from it would be removed from the flow. `per_page` stays
   * at the 20 the route defaults to, as the document gives it no maximum.
   */
  private triggerBindings(trigger: string) {
    const path = `/actions/triggers/${pathEncode(trigger)}/bindings` as const;
    return pages(path, "bindings", ({ page }) => this.rest.get(path, { query: { page } }), {
      perPage: 20,
    });
  }

  /** Action ids currently bound into any flow (one call per trigger). */
  private async boundActionIds(): Promise<Set<string>> {
    const triggers = await this.actionTriggers();
    const ids = new Set<string>();
    const unique = [...new Set((triggers.triggers ?? []).map((t) => str(t.id)).filter(Boolean))];
    const settled = await Promise.allSettled(unique.map((t) => this.triggerBindings(t)));
    for (const result of settled) {
      if (result.status !== "fulfilled") {
        rethrowIncompleteList(result.reason);
        continue;
      }
      for (const b of result.value) if (b.action?.id) ids.add(b.action.id);
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
      this.rest.get("/tenants/settings"),
      this.rest.get("/branding").catch((): A0Branding => ({})),
      this.rest.get("/stats/active-users").catch(() => undefined),
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

  mapConnection(
    accountId: string,
    c: A0Connection,
    enabledClients = c.enabled_clients,
  ): ResourceInstance {
    return this.instance(
      accountId,
      "connection",
      str(c.id),
      str(c.display_name) || str(c.name),
      {
        name: str(c.name),
        displayName: str(c.display_name),
        strategy: str(c.strategy),
        enabledClients: (enabledClients ?? []).join(", "),
        isDomainConnection: c.is_domain_connection === true,
        showAsButton: c.show_as_button === true,
        realms: (c.realms ?? []).join(", "),
      },
      { connectionId: str(c.id), name: str(c.name) },
    );
  }

  mapUser(accountId: string, u: A0User | ExportedUser): ResourceInstance {
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
    const sink: { [key: string]: Loose } = s.sink ?? {};
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

  verifyCredentials(): PluginEffect<PreflightResult> {
    return attempt(async () => {
      const checks: PreflightCapabilityCheck[] = [];
      const probe = async <T>(capabilityId: string, read: () => Promise<T>, scope: string) => {
        await read().then(
          () => {
            checks.push({ capabilityId, status: "ok" });
          },
          (error: { status?: number; message: string }) => {
            checks.push(
              error.status === 401 || error.status === 403
                ? {
                    capabilityId,
                    status: "missing",
                    missingPermissions: [{ id: scope, label: scope }],
                    message: error.message,
                  }
                : { capabilityId, status: "unknown", message: error.message },
            );
          },
        );
      };
      const query = { per_page: 1 };
      await probe(
        "tenant",
        () => this.rest.get("/tenants/settings", { query }),
        "read:tenant_settings",
      );
      await probe("applications", () => this.rest.get("/clients", { query }), "read:clients");
      await probe("users", () => this.rest.get("/users", { query }), "read:users");
      await probe("actions", () => this.rest.get("/actions/actions", { query }), "read:actions");
      await probe("logs", () => this.rest.get("/logs", { query }), "read:logs");
      await probe("stats", () => this.rest.get("/stats/daily", { query }), "read:stats");
      return { checks, identity: this.api.domain };
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
      if (resourceTypeId !== "tenant") return [];
      const endMs = timeRange?.endMs ?? Date.now();
      const startMs = timeRange?.startMs ?? endMs - METRICS_DEFAULT_RANGE_MS;
      const ymd = (ms: number) => new Date(ms).toISOString().slice(0, 10).replace(/-/g, "");
      const days = await this.rest.get("/stats/daily", {
        query: { from: ymd(startMs), to: ymd(endMs) },
      });
      const points = (pick: (d: (typeof days)[number]) => number | undefined) =>
        (days ?? [])
          .map((d) => ({ timestamp: Date.parse(str(d.date)), value: pick(d) ?? 0 }))
          .filter((p) => Number.isFinite(p.timestamp))
          .sort((a, b) => a.timestamp - b.timestamp);
      return [
        { label: "Logins", unit: "count", points: points((d) => d.logins) },
        { label: "Signups", unit: "count", points: points((d) => d.signups) },
        { label: "Leaked passwords", unit: "count", points: points((d) => d.leaked_passwords) },
      ];
    });
  }

  /**
   * Auth0 publishes no usage API for its rate limits; every Management API
   * response carries `x-ratelimit-limit`/`-remaining` for the tenant's
   * bucket, so one cheap read reports the headroom Auth0 states.
   */
  fetchQuotas(_accountId: string): PluginEffect<QuotaUsage[]> {
    return attempt(async () => {
      const res = await this.rest.getResponse("/stats/active-users");
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
    });
  }

  fetchDashboardStats(resourceTypeId: string, resourceId: string): PluginEffect<DashboardStat[]> {
    return attempt(async () => {
      const id = pathEncode(externalIdOf(resourceId));
      if (resourceTypeId === "tenant") {
        const today = new Date().toISOString().slice(0, 10).replace(/-/g, "");
        const [active, days] = await Promise.all([
          this.rest.get("/stats/active-users").catch(() => undefined),
          this.rest.get("/stats/daily", { query: { from: today, to: today } }).catch(() => []),
        ]);
        return [
          { label: "Active users (30d)", value: active === undefined ? "—" : String(active) },
          { label: "Logins today", value: String(days?.[0]?.logins ?? 0) },
          { label: "Signups today", value: String(days?.[0]?.signups ?? 0) },
        ];
      }
      if (resourceTypeId === "organization") {
        const members = await this.rest
          .get(`/organizations/${id}/members`, {
            query: { per_page: 1, include_totals: true },
          })
          .catch(() => ({ total: undefined }));
        return [
          { label: "Members", value: members.total === undefined ? "—" : String(members.total) },
        ];
      }
      if (resourceTypeId === "role") {
        const users = await this.rest
          .get(`/roles/${id}/users`, {
            query: { per_page: 1, include_totals: true },
          })
          .catch(() => ({ total: undefined }));
        return [{ label: "Users", value: users.total === undefined ? "—" : String(users.total) }];
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
      const perPage = Math.min(Math.max(params.tailLines ?? 100, 1), 100);
      let logs: A0Log[];
      if (typeId === "user") {
        logs = await this.rest.get(`/users/${pathEncode(id)}/logs`, {
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
        logs = await this.rest.get("/logs", {
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
    });
  }

  // -------------------------------------------------------------------------
  // Attack protection (settings editor on the tenant)
  // -------------------------------------------------------------------------

  getManifest(): PluginEffect<string> {
    return attempt(async () => {
      const [bf, bp, sit, flags] = await Promise.all([
        this.rest.get("/attack-protection/brute-force-protection"),
        this.rest.get("/attack-protection/breached-password-detection"),
        this.rest.get("/attack-protection/suspicious-ip-throttling"),
        this.rest.get("/tenants/settings"),
      ]);
      const tf = flags.flags;
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
          value: tf?.enable_client_connections ? "on" : "off",
        },
        {
          id: "flags.disable_clickjack_protection_headers",
          label: "Disable clickjacking protection headers",
          group: "Tenant flags",
          control: "toggle",
          value: tf?.disable_clickjack_protection_headers ? "on" : "off",
        },
        {
          id: "flags.enable_public_signup_user_exists_error",
          label: "Tell sign-up that the user already exists",
          group: "Tenant flags",
          control: "toggle",
          value: tf?.enable_public_signup_user_exists_error ? "on" : "off",
        },
      ];
      return JSON.stringify({ settings });
    });
  }

  applyManifest(_resourceId: string, _accountId: string, manifest: string): PluginEffect<void> {
    return attempt(async () => {
      const changes: Array<{ id: string; value: string }> = JSON.parse(manifest);
      const on = (v: string) => v === "on" || v === "true";
      const bf: ApiBody<operations["patch_brute-force-protection"]> = {};
      const flags: Record<string, boolean> = {};
      for (const { id, value } of changes) {
        if (id === "bf.enabled") bf.enabled = on(value);
        else if (id === "bf.max_attempts") bf.max_attempts = Number(value);
        else if (id === "bp.enabled") {
          await this.rest.patch("/attack-protection/breached-password-detection", {
            body: { enabled: on(value) },
          });
        } else if (id === "sit.enabled") {
          await this.rest.patch("/attack-protection/suspicious-ip-throttling", {
            body: { enabled: on(value) },
          });
        } else if (id.startsWith("flags.")) flags[id.slice(6)] = on(value);
      }
      if (Object.keys(bf).length > 0) {
        await this.rest.patch("/attack-protection/brute-force-protection", { body: bf });
      }
      if (Object.keys(flags).length > 0) {
        await this.rest.patch("/tenants/settings", { body: { flags } });
      }
    });
  }

  // -------------------------------------------------------------------------
  // Create
  // -------------------------------------------------------------------------

  private async connectionOptions(strategy?: "auth0"): Promise<SelectOption[]> {
    const connections = await pages(
      "/connections",
      "connections",
      (paging) =>
        this.rest.get("/connections", {
          query: { ...(strategy ? { strategy: [strategy] } : {}), ...paging },
        }),
      PICKER,
    ).catch((): A0Connection[] => []);
    return connections.map((c) => ({
      id: str(c.name),
      label: str(c.display_name) || str(c.name),
      description: str(c.strategy),
    }));
  }

  getCreateConfig(typeId: string): PluginEffect<CreateResourceConfig> {
    return attempt(async () => {
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
          const triggers = await this.actionTriggers();
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
    });
  }

  private async clientPolicies(): Promise<PolicyOption[]> {
    const clients = await pages(
      "/clients",
      "clients",
      (paging) => this.rest.get("/clients", { query: { is_global: false, ...paging } }),
      PICKER,
    ).catch((): A0Client[] => []);
    return clients.map((c) => ({
      id: str(c.client_id),
      label: str(c.name),
      category: str(c.app_type) || "application",
    }));
  }

  private async connectionIdOptions(): Promise<SelectOption[]> {
    const connections = await pages(
      "/connections",
      "connections",
      (paging) => this.rest.get("/connections", { query: paging }),
      PICKER,
    ).catch((): A0Connection[] => []);
    return connections.map((c) => ({
      id: str(c.id),
      label: str(c.display_name) || str(c.name),
      description: str(c.strategy),
    }));
  }

  /** Every API permission, as `identifier|scope` ids. */
  async permissionPolicies(): Promise<PolicyOption[]> {
    const apis = await pages(
      "/resource-servers",
      "resource_servers",
      (paging) => this.rest.get("/resource-servers", { query: paging }),
      PICKER,
    ).catch((): A0ResourceServer[] => []);
    return apis.flatMap((api) =>
      (api.scopes ?? []).map((scope) => ({
        id: `${str(api.identifier)}|${str(scope.value)}`,
        label: str(scope.value),
        ...(scope.description ? { description: str(scope.description) } : {}),
        category: str(api.name) || str(api.identifier),
      })),
    );
  }

  private permissionsBody(ids: string[]): ApiBody<operations["post_role_permission_assignment"]> {
    return {
      permissions: ids.map((id) => {
        const bar = id.lastIndexOf("|");
        return { resource_server_identifier: id.slice(0, bar), permission_name: id.slice(bar + 1) };
      }),
    };
  }

  createResource(
    typeId: string,
    accountId: string,
    fields: Record<string, string>,
  ): PluginEffect<ResourceInstance> {
    return attempt(async () => {
      switch (typeId) {
        case "application": {
          const appType = fields["appType"] || "regular_web";
          const client = await this.rest.post("/clients", {
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
          const server = await this.rest.post("/resource-servers", {
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
          const connection = await this.rest.post("/connections", {
            body: { name: fields["name"], strategy: fields["strategy"] || "auth0" },
          });
          const clients = list(fields["enabledClients"]);
          if (clients.length > 0) {
            await this.rest.patch(`/connections/${pathEncode(str(connection.id))}/clients`, {
              body: clients.map((client_id) => ({ client_id, status: true })),
            });
          }
          return this.mapReadConnection(accountId, connection);
        }
        case "user": {
          const verified = fields["emailVerified"] === "true";
          const user = await this.rest.post("/users", {
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
          const role = await this.rest.post("/roles", {
            body: {
              name: fields["name"],
              ...(fields["description"] ? { description: fields["description"] } : {}),
            },
          });
          const permissions = list(fields["permissions"]);
          if (permissions.length > 0) {
            await this.rest.post(`/roles/${pathEncode(str(role.id))}/permissions`, {
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
          const org = await this.rest.post("/organizations", {
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
          const [id = "", version] = (fields["trigger"] || "post-login@v3").split("@");
          const action = await this.rest.post("/actions/actions", {
            body: {
              name: fields["name"],
              supported_triggers: [{ id, ...(version !== undefined ? { version } : {}) }],
              code: fields["code"] || ACTION_TEMPLATE,
              runtime: fields["runtime"] || "node22",
            },
          });
          return this.mapAction(accountId, action, new Set());
        }
        case "log-stream": {
          const type = fields["type"] || "http";
          const sinks: Record<string, Record<string, string | boolean | undefined>> = {
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
          const stream = await this.rest.post("/log-streams", {
            body: { name: fields["name"], type, sink },
          });
          return this.mapLogStream(accountId, stream);
        }
        case "custom-domain": {
          const domain = await this.rest.post("/custom-domains", {
            body: { domain: fields["domain"], type: fields["type"] || "auth0_managed_certs" },
          });
          return this.mapCustomDomain(accountId, domain);
        }
        default:
          throw new Error(`Auth0 plugin: cannot create resource type "${typeId}"`);
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
      const has = (key: string) => fields[key] !== undefined;
      switch (typeId) {
        case "tenant": {
          const settings: ApiBody<operations["patch_settings"]> = {};
          if (has("friendlyName")) settings.friendly_name = fields["friendlyName"];
          if (has("supportEmail")) settings.support_email = fields["supportEmail"];
          if (has("supportUrl")) settings.support_url = fields["supportUrl"];
          if (has("pictureUrl")) settings.picture_url = fields["pictureUrl"];
          if (has("defaultAudience")) settings.default_audience = fields["defaultAudience"];
          if (has("defaultDirectory")) settings.default_directory = fields["defaultDirectory"];
          if (fields["sessionLifetime"])
            settings.session_lifetime = Number(fields["sessionLifetime"]);
          if (fields["idleSessionLifetime"])
            settings.idle_session_lifetime = Number(fields["idleSessionLifetime"]);
          if (has("enabledLocales")) settings.enabled_locales = list(fields["enabledLocales"]);
          if (Object.keys(settings).length > 0)
            await this.rest.patch("/tenants/settings", { body: settings });
          const branding: ApiBody<operations["patch_branding"]> = {};
          const colors: NonNullable<ApiBody<operations["patch_branding"]>["colors"]> = {};
          if (fields["brandPrimaryColor"]) colors.primary = fields["brandPrimaryColor"];
          if (fields["brandBackgroundColor"])
            colors.page_background = fields["brandBackgroundColor"];
          if (Object.keys(colors).length > 0) branding.colors = colors;
          if (has("brandLogoUrl")) branding.logo_url = fields["brandLogoUrl"];
          if (has("brandFaviconUrl")) branding.favicon_url = fields["brandFaviconUrl"];
          if (Object.keys(branding).length > 0)
            await this.rest.patch("/branding", { body: branding });
          return this.tenantResource(accountId);
        }
        case "application": {
          const body: ApiBody<operations["patch_clients_by_id"]> = {};
          if (has("name")) body.name = fields["name"];
          if (has("description")) body.description = fields["description"];
          if (has("callbacks")) body.callbacks = list(fields["callbacks"]);
          if (has("allowedLogoutUrls"))
            body.allowed_logout_urls = list(fields["allowedLogoutUrls"]);
          if (has("webOrigins")) body.web_origins = list(fields["webOrigins"]);
          if (has("allowedOrigins")) body.allowed_origins = list(fields["allowedOrigins"]);
          if (has("initiateLoginUri")) body.initiate_login_uri = fields["initiateLoginUri"];
          if (has("logoUri")) body.logo_uri = fields["logoUri"];
          return this.mapClient(accountId, await this.rest.patch(`/clients/${id}`, { body }));
        }
        case "api": {
          const body: ApiBody<operations["patch_resource-servers_by_id"]> = {};
          if (has("name")) body.name = fields["name"];
          if (fields["signingAlg"]) body.signing_alg = fields["signingAlg"];
          if (fields["tokenLifetime"]) body.token_lifetime = Number(fields["tokenLifetime"]);
          if (fields["tokenLifetimeForWeb"])
            body.token_lifetime_for_web = Number(fields["tokenLifetimeForWeb"]);
          const offline = bool(fields["allowOfflineAccess"]);
          if (offline !== undefined) body.allow_offline_access = offline;
          const skipConsent = bool(fields["skipConsent"]);
          if (skipConsent !== undefined)
            body.skip_consent_for_verifiable_first_party_clients = skipConsent;
          const enforce = bool(fields["enforcePolicies"]);
          if (enforce !== undefined) body.enforce_policies = enforce;
          if (fields["tokenDialect"]) body.token_dialect = fields["tokenDialect"];
          return this.mapApi(accountId, await this.rest.patch(`/resource-servers/${id}`, { body }));
        }
        case "connection": {
          const body: ApiBody<operations["patch_connections_by_id"]> = {};
          if (has("displayName")) body.display_name = fields["displayName"];
          const domain = bool(fields["isDomainConnection"]);
          if (domain !== undefined) body.is_domain_connection = domain;
          const button = bool(fields["showAsButton"]);
          if (button !== undefined) body.show_as_button = button;
          return this.mapReadConnection(
            accountId,
            await this.rest.patch(`/connections/${id}`, { body }),
          );
        }
        case "user": {
          const body: ApiBody<operations["patch_users_by_id"]> = {};
          if (has("email")) body.email = fields["email"];
          if (has("name")) body.name = fields["name"];
          if (has("nickname")) body.nickname = fields["nickname"];
          const verified = bool(fields["emailVerified"]);
          if (verified !== undefined) body.email_verified = verified;
          const blocked = bool(fields["blocked"]);
          if (blocked !== undefined) body.blocked = blocked;
          return this.mapUser(accountId, await this.rest.patch(`/users/${id}`, { body }));
        }
        case "role": {
          const body: ApiBody<operations["patch_roles_by_id"]> = {};
          if (has("name")) body.name = fields["name"];
          if (has("description")) body.description = fields["description"];
          await this.rest.patch(`/roles/${id}`, { body });
          return runPluginEffect(this.getResource(typeId, resourceId, accountId));
        }
        case "organization": {
          const current = await this.rest.get(`/organizations/${id}`);
          const body: ApiBody<operations["patch_organizations_by_id"]> = {};
          if (has("name")) body.name = fields["name"];
          if (has("displayName")) body.display_name = fields["displayName"];
          if (has("logoUrl") || has("primaryColor") || has("backgroundColor")) {
            const branding: Partial<NonNullable<typeof current.branding>> = {
              ...(current.branding ?? {}),
            };
            const colors: Partial<NonNullable<NonNullable<typeof current.branding>["colors"]>> = {
              ...(current.branding?.colors ?? {}),
            };
            const logoUrl = fields["logoUrl"];
            if (logoUrl !== undefined) branding.logo_url = logoUrl;
            if (fields["primaryColor"]) colors.primary = fields["primaryColor"];
            if (fields["backgroundColor"]) colors.page_background = fields["backgroundColor"];
            const { primary, page_background } = colors;
            if (primary && page_background)
              branding.colors = { ...colors, primary, page_background };
            body.branding = branding;
          }
          return this.mapOrganization(
            accountId,
            await this.rest.patch(`/organizations/${id}`, { body }),
          );
        }
        case "action": {
          const body: ApiBody<operations["patch_action"]> = {};
          if (has("name")) body.name = fields["name"];
          if (fields["runtime"]) body.runtime = fields["runtime"];
          await this.rest.patch(`/actions/actions/${id}`, { body });
          return runPluginEffect(this.getResource(typeId, resourceId, accountId));
        }
        case "log-stream": {
          const body: ApiBody<operations["patch_log-streams_by_id"]> = {};
          if (has("name")) body.name = fields["name"];
          if (fields["status"]) body.status = fields["status"];
          return this.mapLogStream(
            accountId,
            await this.rest.patch(`/log-streams/${id}`, { body }),
          );
        }
        case "custom-domain": {
          const body: ApiBody<operations["patch_custom-domains_by_id"]> = {};
          if (fields["tlsPolicy"]) body.tls_policy = fields["tlsPolicy"];
          if (has("customClientIpHeader"))
            body.custom_client_ip_header = fields["customClientIpHeader"];
          return this.mapCustomDomain(
            accountId,
            await this.rest.patch(`/custom-domains/${id}`, { body }),
          );
        }
        default:
          throw new Error(`Auth0 plugin: cannot update resource type "${typeId}"`);
      }
    });
  }

  deleteResource(typeId: string, resourceId: string): PluginEffect<void> {
    return attempt(async () => {
      const id = pathEncode(externalIdOf(resourceId));
      switch (typeId) {
        case "application":
          await this.rest.delete(`/clients/${id}`);
          return;
        case "api":
          await this.rest.delete(`/resource-servers/${id}`);
          return;
        case "connection":
          await this.rest.delete(`/connections/${id}`);
          return;
        case "user":
          await this.rest.delete(`/users/${id}`);
          return;
        case "role":
          await this.rest.delete(`/roles/${id}`);
          return;
        case "organization":
          await this.rest.delete(`/organizations/${id}`);
          return;
        case "action":
          // Actions still bound into a flow need `force` to delete.
          await this.rest.delete(`/actions/actions/${id}`, { query: { force: true } });
          return;
        case "log-stream":
          await this.rest.delete(`/log-streams/${id}`);
          return;
        case "custom-domain":
          await this.rest.delete(`/custom-domains/${id}`);
          return;
        default:
          throw new Error(`Auth0 plugin: cannot delete resource type "${typeId}"`);
      }
    });
  }

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  invokeAction(typeId: string, resourceId: string, actionId: string): PluginEffect<void> {
    return attempt(async () => {
      const raw = externalIdOf(resourceId);
      const id = pathEncode(raw);
      switch (`${typeId}:${actionId}`) {
        case "application:rotate-secret":
          await this.rest.post(`/clients/${id}/rotate-secret`);
          return;
        case "user:block":
        case "user:unblock":
          await this.rest.patch(`/users/${id}`, { body: { blocked: actionId === "block" } });
          return;
        case "user:send-verification":
          await this.rest.post("/jobs/verification-email", { body: { user_id: raw } });
          return;
        case "user:reset-mfa":
          await this.rest.delete(`/users/${id}/authentication-methods`);
          return;
        case "action:deploy":
          await this.rest.post(`/actions/actions/${id}/deploy`);
          return;
        case "action:bind": {
          const action = await this.rest.get(`/actions/actions/${id}`);
          const trigger = str(action.supported_triggers?.[0]?.id);
          if (!trigger) throw new Error("Auth0 plugin: the action has no trigger");
          const current = await this.triggerBindings(trigger);
          if (current.some((b) => b.action?.id === raw)) return;
          const bindings = current.map((b): ActionBindingUpdate => ({
            ref: { type: "binding_id", value: str(b.id) },
            display_name: str(b.display_name),
          }));
          bindings.push({ ref: { type: "action_id", value: raw }, display_name: str(action.name) });
          await this.rest.patch(`/actions/triggers/${pathEncode(trigger)}/bindings`, {
            body: { bindings },
          });
          return;
        }
        case "action:unbind": {
          const action = await this.rest.get(`/actions/actions/${id}`);
          const trigger = str(action.supported_triggers?.[0]?.id);
          if (!trigger) throw new Error("Auth0 plugin: the action has no trigger");
          const current = await this.triggerBindings(trigger);
          const bindings = current
            .filter((b) => b.action?.id !== raw)
            .map((b): ActionBindingUpdate => ({
              ref: { type: "binding_id", value: str(b.id) },
              display_name: str(b.display_name),
            }));
          await this.rest.patch(`/actions/triggers/${pathEncode(trigger)}/bindings`, {
            body: { bindings },
          });
          return;
        }
        case "custom-domain:verify":
          await this.rest.post(`/custom-domains/${id}/verify`);
          return;
        case "log-stream:pause":
        case "log-stream:resume":
          await this.rest.patch(`/log-streams/${id}`, {
            body: { status: actionId === "pause" ? "paused" : "active" },
          });
          return;
        default:
          throw new Error(`Auth0 plugin: unknown action "${actionId}" for type "${typeId}"`);
      }
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
      const raw = externalIdOf(resourceId);
      const id = pathEncode(raw);
      const need = (key: string, what: string): string => {
        const value = values[key];
        if (!value) throw new Error(`Auth0 plugin: choose ${what}`);
        return value;
      };
      switch (`${typeId}:${command}`) {
        case "action:edit-code": {
          await this.rest.patch(`/actions/actions/${id}`, {
            body: { code: values["code"] ?? "" },
          });
          if (values["deploy"] === "true") await this.rest.post(`/actions/actions/${id}/deploy`);
          return { ok: true };
        }
        case "api:set-scopes": {
          const scopes = list(values["scopes"]).map((value) => ({ value, description: value }));
          return this.rest.patch(`/resource-servers/${id}`, { body: { scopes } });
        }
        case "role:add-permissions":
          return this.rest.post(`/roles/${id}/permissions`, {
            body: this.permissionsBody(list(values["permissions"])),
          });
        case "role:remove-permissions":
          return this.rest.delete(`/roles/${id}/permissions`, {
            body: this.permissionsBody(list(values["permissions"])),
          });
        case "user:assign-roles":
          return this.rest.post(`/users/${id}/roles`, { body: { roles: list(values["roles"]) } });
        case "user:remove-roles":
          return this.rest.delete(`/users/${id}/roles`, {
            body: { roles: list(values["roles"]) },
          });
        case "connection:enable-clients":
        case "connection:disable-clients":
          return this.rest.patch(`/connections/${id}/clients`, {
            body: list(values["clients"]).map((client_id) => ({
              client_id,
              status: command === "enable-clients",
            })),
          });
        case "organization:add-members":
          return this.rest.post(`/organizations/${id}/members`, {
            body: { members: list(values["users"]) },
          });
        case "organization:remove-members":
          return this.rest.delete(`/organizations/${id}/members`, {
            body: { members: list(values["users"]) },
          });
        case "organization:enable-connection":
          return this.rest.post(`/organizations/${id}/enabled_connections`, {
            body: {
              connection_id: need("connectionId", "a connection"),
              assign_membership_on_login: values["autoMembership"] === "true",
            },
          });
        case "organization:disable-connection":
          return this.rest.delete(
            `/organizations/${id}/enabled_connections/${pathEncode(need("connectionId", "a connection"))}`,
          );
        case "organization:invite": {
          const clientId = need("clientId", "an application");
          return this.rest.post(`/organizations/${id}/invitations`, {
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
    });
  }

  exportCredential(
    typeId: string,
    resourceId: string,
    _accountId: string,
    formatId: string,
  ): PluginEffect<CredentialExport> {
    return attempt(async () => {
      if (typeId === "user" && formatId === "password-reset-link") {
        const body = await this.rest.post("/tickets/password-change", {
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
    });
  }

  // -------------------------------------------------------------------------
  // Detail enrichment + rendering
  // -------------------------------------------------------------------------

  enrichDetail(resource: ResourceInstance): PluginEffect<ResourceInstance> {
    return attempt(async () => {
      const raw = externalIdOf(resource.id);
      const id = pathEncode(raw);
      const extra: Record<string, string> = {};
      switch (resource.resourceTypeId) {
        case "user": {
          const [roles, allRoles] = await Promise.all([
            pages(
              `/users/${id}/roles`,
              "roles",
              (paging) => this.rest.get(`/users/${id}/roles`, { query: paging }),
              PICKER,
            ).catch((): A0Role[] => []),
            pages(
              "/roles",
              "roles",
              (paging) => this.rest.get("/roles", { query: paging }),
              PICKER,
            ).catch((): A0Role[] => []),
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
            this.rolePermissions(raw).catch((err) => {
              rethrowIncompleteList(err);
              return [];
            }),
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
            this.enabledClientIds(raw).catch((): string[] => []),
            this.clientPolicies(),
            this.rest
              .get(`/connections/${id}/status`)
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
            pages(
              `/organizations/${id}/members`,
              "members",
              (paging) => this.rest.get(`/organizations/${id}/members`, { query: paging }),
              PICKER,
            ).catch(() => []),
            // Two pages only: /users is a slow search, and this runs on every open of the view.
            pages("/users", "users", (paging) => this.rest.get("/users", { query: paging }), {
              maxPages: 2,
              partial: true,
            }).catch((): A0User[] => []),
            this.connectionIdOptions(),
            pages(
              `/organizations/${id}/enabled_connections`,
              "enabled_connections",
              (paging) =>
                this.rest.get(`/organizations/${id}/enabled_connections`, { query: paging }),
              PICKER,
            ).catch(() => []),
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
    });
  }

  renderDetail(resource: ResourceInstance): DetailViewSchema {
    return renderDetail(resource, this.api.domain);
  }

  renderSidebarItem(resource: ResourceInstance): SidebarItemSchema {
    return renderSidebarItem(resource);
  }
}
