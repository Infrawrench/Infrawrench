import type {
  CreateResourceConfig,
  CredentialExport,
  DashboardStat,
  DetailViewSchema,
  HostServices,
  MetricSeries,
  PluginClient,
  PreflightCapabilityCheck,
  PreflightResult,
  ResourceInstance,
  SelectOption,
  SettingDescriptor,
  SidebarItemSchema,
} from "@infrawrench/plugin-base";
import { externalIdOf } from "@infrawrench/plugin-base";
import { ClerkApi } from "./api.js";
import { renderDetail, renderSidebarItem } from "./render.js";
import type {
  CkDomain,
  CkEnterpriseConnection,
  CkIdentifier,
  CkInstance,
  CkInvitation,
  CkJwtTemplate,
  CkMachine,
  CkMembership,
  CkOAuthApp,
  CkOrgRole,
  CkOrganization,
  CkOrgSettings,
  CkProtect,
  CkRedirectUrl,
  CkRestrictions,
  CkSession,
  CkUser,
} from "./types.js";

const PLUGIN_ID = "clerk";
export const METRICS_DEFAULT_RANGE_MS = 14 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

function str(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

/** Clerk timestamps are Unix milliseconds. */
function iso(ms: unknown): string {
  return typeof ms === "number" && Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : "";
}

function bool(value: string | undefined): boolean | undefined {
  if (value === undefined || value === "") return undefined;
  return value === "true" || value === "1" || value === "yes" || value === "on";
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

function primaryEmail(u: CkUser): string {
  const emails = u.email_addresses ?? [];
  return str((emails.find((e) => e.id === u.primary_email_address_id) ?? emails[0])?.email_address);
}

export class ClerkClient implements PluginClient {
  readonly api: ClerkApi;

  constructor(credentials: Record<string, string>, services?: HostServices) {
    const secretKey = (credentials["secretKey"] ?? "").trim();
    if (!secretKey) throw new Error("Clerk plugin: missing secretKey credential");
    if (!/^sk_(live|test)_/.test(secretKey)) {
      throw new Error(
        "Clerk plugin: the secret key should start with sk_live_ or sk_test_ (the publishable pk_ key will not work)",
      );
    }
    this.api = new ClerkApi(secretKey, credentials["caCert"] ?? "", services);
  }

  // -------------------------------------------------------------------------
  // Listing
  // -------------------------------------------------------------------------

  async listResources(typeId: string, accountId: string): Promise<ResourceInstance[]> {
    switch (typeId) {
      case "instance":
        return [await this.instanceResource(accountId)];
      case "user":
        return (await this.api.list<CkUser>("/users", { order_by: "-created_at" })).map((u) =>
          this.mapUser(accountId, u),
        );
      case "organization":
        return (
          await this.api.list<CkOrganization>("/organizations", { include_members_count: true })
        ).map((o) => this.mapOrganization(accountId, o));
      case "domain":
        return (await this.api.list<CkDomain>("/domains")).map((d) => this.mapDomain(accountId, d));
      case "jwt-template":
        return (await this.api.list<CkJwtTemplate>("/jwt_templates")).map((t) =>
          this.mapJwtTemplate(accountId, t),
        );
      case "oauth-application":
        return (await this.api.list<CkOAuthApp>("/oauth_applications")).map((a) =>
          this.mapOAuthApp(accountId, a),
        );
      case "enterprise-connection":
        return (await this.api.list<CkEnterpriseConnection>("/enterprise_connections")).map((c) =>
          this.mapEnterpriseConnection(accountId, c),
        );
      case "machine":
        return (await this.api.list<CkMachine>("/machines")).map((m) =>
          this.mapMachine(accountId, m),
        );
      case "allowlist-identifier":
        return (await this.api.list<CkIdentifier>("/allowlist_identifiers")).map((i) =>
          this.mapIdentifier(accountId, "allowlist-identifier", i),
        );
      case "blocklist-identifier": {
        const body = await this.api.request<CkIdentifier[] | { data?: CkIdentifier[] }>(
          "/blocklist_identifiers",
        );
        const items = Array.isArray(body) ? body : (body.data ?? []);
        return items.map((i) => this.mapIdentifier(accountId, "blocklist-identifier", i));
      }
      case "invitation":
        return (await this.api.list<CkInvitation>("/invitations", { status: "pending" })).map((i) =>
          this.mapInvitation(accountId, i),
        );
      case "redirect-url":
        return (await this.api.list<CkRedirectUrl>("/redirect_urls")).map((r) =>
          this.mapRedirectUrl(accountId, r),
        );
      default:
        throw new Error(`Clerk plugin: unknown resource type "${typeId}"`);
    }
  }

  async getResource(
    typeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<ResourceInstance> {
    const raw = externalIdOf(resourceId);
    const id = encodeURIComponent(raw);
    switch (typeId) {
      case "instance":
        return this.instanceResource(accountId);
      case "user":
        return this.mapUser(accountId, await this.api.request<CkUser>(`/users/${id}`));
      case "organization":
        return this.mapOrganization(
          accountId,
          await this.api.request<CkOrganization>(`/organizations/${id}`, {
            query: { include_members_count: true },
          }),
        );
      case "jwt-template":
        return this.mapJwtTemplate(
          accountId,
          await this.api.request<CkJwtTemplate>(`/jwt_templates/${id}`),
        );
      case "oauth-application":
        return this.mapOAuthApp(
          accountId,
          await this.api.request<CkOAuthApp>(`/oauth_applications/${id}`),
        );
      case "enterprise-connection":
        return this.mapEnterpriseConnection(
          accountId,
          await this.api.request<CkEnterpriseConnection>(`/enterprise_connections/${id}`),
        );
      case "machine":
        return this.mapMachine(accountId, await this.api.request<CkMachine>(`/machines/${id}`));
      default: {
        // Domains, list entries, invitations and redirect URLs have no single GET worth using.
        const match = (await this.listResources(typeId, accountId)).find(
          (r) => r.externalId === raw,
        );
        if (!match)
          throw Object.assign(new Error(`Clerk plugin: ${typeId} "${raw}" not found`), {
            status: 404,
          });
        return match;
      }
    }
  }

  async resolveOutput(
    typeId: string,
    resourceId: string,
    outputKey: string,
    accountId: string,
  ): Promise<string> {
    if (typeId === "machine" && outputKey === "secretKey") {
      const body = await this.api.request<{ secret?: string }>(
        `/machines/${encodeURIComponent(externalIdOf(resourceId))}/secret_key`,
      );
      if (!body.secret) throw new Error("Clerk plugin: Clerk returned no machine secret");
      return body.secret;
    }
    const resource = await this.getResource(typeId, resourceId, accountId);
    const value = resource.resolvedOutputs[outputKey];
    if (value !== undefined && value !== "") return value;
    throw new Error(`Clerk plugin: cannot resolve output "${outputKey}" for type "${typeId}"`);
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
    createdAt?: unknown,
    updatedAt?: unknown,
  ): ResourceInstance {
    const created = iso(createdAt) || new Date(0).toISOString();
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
      updatedAt: iso(updatedAt) || created,
    };
  }

  private async instanceResource(accountId: string): Promise<ResourceInstance> {
    const [instance, domains, users, active, orgSettings] = await Promise.all([
      this.api.request<CkInstance>("/instance"),
      this.api.list<CkDomain>("/domains").catch(() => [] as CkDomain[]),
      this.api
        .request<{ total_count?: number }>("/users/count")
        .catch(() => ({ total_count: undefined })),
      this.api
        .request<{ total_count?: number }>("/users/count", {
          query: { last_active_at_since: Date.now() - 30 * DAY_MS },
        })
        .catch(() => ({ total_count: undefined })),
      this.api.request<CkOrgSettings>("/instance/organization_settings").catch(() => undefined),
    ]);
    return this.mapInstance(
      accountId,
      instance,
      domains,
      users.total_count,
      active.total_count,
      orgSettings,
    );
  }

  mapInstance(
    accountId: string,
    i: CkInstance,
    domains: CkDomain[],
    userCount?: number,
    active?: number,
    orgSettings?: CkOrgSettings,
  ): ResourceInstance {
    const primary = domains.find((d) => !d.is_satellite) ?? domains[0];
    const env = str(i.environment_type) || (this.api.isDevelopment ? "development" : "production");
    return this.instance(
      accountId,
      "instance",
      str(i.id),
      `${str(primary?.name) || "Clerk"} (${env})`,
      {
        instanceId: str(i.id),
        environmentType: env,
        allowedOrigins: (i.allowed_origins ?? []).join(", "),
        primaryDomain: str(primary?.name),
        frontendApiUrl: str(primary?.frontend_api_url),
        ...(typeof userCount === "number" ? { userCount } : {}),
        ...(typeof active === "number" ? { activeUsers30d: active } : {}),
        ...(orgSettings ? { organizationsEnabled: orgSettings.enabled === true } : {}),
      },
      { frontendApiUrl: str(primary?.frontend_api_url), instanceId: str(i.id) },
    );
  }

  mapUser(accountId: string, u: CkUser): ResourceInstance {
    const email = primaryEmail(u);
    const name = [str(u.first_name), str(u.last_name)].filter(Boolean).join(" ");
    const methods = [
      u.password_enabled ? "password" : "",
      ...(u.external_accounts ?? []).map((a) => str(a.provider).replace(/^oauth_/, "")),
      ...((u.enterprise_accounts ?? []).length > 0 ? ["enterprise SSO"] : []),
      (u.passkeys ?? []).length > 0 ? "passkey" : "",
    ].filter(Boolean);
    return this.instance(
      accountId,
      "user",
      str(u.id),
      email || str(u.username) || name || str(u.id),
      {
        email,
        firstName: str(u.first_name),
        lastName: str(u.last_name),
        username: str(u.username),
        externalId: str(u.external_id),
        userId: str(u.id),
        banned: u.banned === true,
        locked: u.locked === true,
        twoFactorEnabled: u.two_factor_enabled === true,
        signInMethods: [...new Set(methods)].join(", "),
        organizations: (u.organization_memberships ?? [])
          .map((m) => str(m.organization?.name))
          .filter(Boolean)
          .join(", "),
        lastSignInAt: iso(u.last_sign_in_at),
        lastActiveAt: iso(u.last_active_at),
        createdAt: iso(u.created_at),
      },
      { userId: str(u.id) },
      u.created_at,
      u.updated_at,
    );
  }

  mapOrganization(accountId: string, o: CkOrganization): ResourceInstance {
    return this.instance(
      accountId,
      "organization",
      str(o.id),
      str(o.name),
      {
        name: str(o.name),
        slug: str(o.slug),
        ...(typeof o.max_allowed_memberships === "number"
          ? { maxAllowedMemberships: o.max_allowed_memberships }
          : {}),
        adminDeleteEnabled: o.admin_delete_enabled === true,
        ...(typeof o.members_count === "number" ? { membersCount: o.members_count } : {}),
        ...(typeof o.pending_invitations_count === "number"
          ? { pendingInvitations: o.pending_invitations_count }
          : {}),
        organizationId: str(o.id),
        createdAt: iso(o.created_at),
      },
      { organizationId: str(o.id), slug: str(o.slug) },
      o.created_at,
      o.updated_at,
    );
  }

  mapDomain(accountId: string, d: CkDomain): ResourceInstance {
    const records =
      d.dns_targets && d.dns_targets.length > 0
        ? d.dns_targets.map((t) => ({
            type: str(t.record_type) || "CNAME",
            host: str(t.host),
            value: str(t.value),
            required: t.required === true,
          }))
        : (d.cname_targets ?? []).map((t) => ({
            type: "CNAME",
            host: str(t.host),
            value: str(t.value),
            required: t.required === true,
          }));
    return this.instance(
      accountId,
      "domain",
      str(d.id),
      str(d.name),
      {
        name: str(d.name),
        isSatellite: d.is_satellite === true,
        proxyUrl: str(d.proxy_url),
        frontendApiUrl: str(d.frontend_api_url),
        accountsPortalUrl: str(d.accounts_portal_url),
        dnsRecords: records.map((r) => `${r.type} ${r.host} → ${r.value}`).join(", "),
      },
      {
        frontendApiUrl: str(d.frontend_api_url),
        name: str(d.name),
        __records__: JSON.stringify(records),
      },
    );
  }

  mapJwtTemplate(accountId: string, t: CkJwtTemplate): ResourceInstance {
    return this.instance(
      accountId,
      "jwt-template",
      str(t.id),
      str(t.name),
      {
        name: str(t.name),
        claims: JSON.stringify(t.claims ?? {}),
        ...(typeof t.lifetime === "number" ? { lifetime: t.lifetime } : {}),
        ...(typeof t.allowed_clock_skew === "number"
          ? { allowedClockSkew: t.allowed_clock_skew }
          : {}),
        signingAlgorithm: str(t.signing_algorithm),
        customSigningKey: t.custom_signing_key === true,
        updatedAt: iso(t.updated_at),
      },
      { name: str(t.name) },
      t.created_at,
      t.updated_at,
    );
  }

  mapOAuthApp(accountId: string, a: CkOAuthApp): ResourceInstance {
    return this.instance(
      accountId,
      "oauth-application",
      str(a.id),
      str(a.name),
      {
        name: str(a.name),
        clientId: str(a.client_id),
        redirectUris: (a.redirect_uris ?? (a.callback_url ? [a.callback_url] : [])).join(", "),
        scopes: str(a.scopes),
        public: a.public === true,
        consentScreenEnabled: a.consent_screen_enabled === true,
        pkceRequired: a.pkce_required === true,
        discoveryUrl: str(a.discovery_url),
        createdAt: iso(a.created_at),
      },
      { clientId: str(a.client_id), discoveryUrl: str(a.discovery_url) },
      a.created_at,
      a.updated_at,
    );
  }

  mapEnterpriseConnection(accountId: string, c: CkEnterpriseConnection): ResourceInstance {
    const saml = c.saml_connection;
    return this.instance(
      accountId,
      "enterprise-connection",
      str(c.id),
      str(c.name),
      {
        name: str(c.name),
        provider: str(c.provider),
        domains: (c.domains ?? []).join(", "),
        active: c.active === true,
        syncUserAttributes: c.sync_user_attributes === true,
        organizationId: str(c.organization_id),
        acsUrl: str(saml?.acs_url),
        spEntityId: str(saml?.sp_entity_id),
        spMetadataUrl: str(saml?.sp_metadata_url),
        idpCertificateExpiresAt: iso(saml?.idp_certificate_expires_at),
      },
      {
        acsUrl: str(saml?.acs_url),
        spEntityId: str(saml?.sp_entity_id),
        spMetadataUrl: str(saml?.sp_metadata_url),
      },
      c.created_at,
      c.updated_at,
    );
  }

  mapMachine(accountId: string, m: CkMachine): ResourceInstance {
    return this.instance(
      accountId,
      "machine",
      str(m.id),
      str(m.name),
      {
        name: str(m.name),
        ...(typeof m.default_token_ttl === "number"
          ? { defaultTokenTtl: m.default_token_ttl }
          : {}),
        scopedMachines: (m.scoped_machines ?? []).map((s) => str(s.name) || str(s.id)).join(", "),
        createdAt: iso(m.created_at),
      },
      {
        machineId: str(m.id),
        __scoped__: JSON.stringify(
          (m.scoped_machines ?? []).map((s) => ({ id: str(s.id), label: str(s.name) })),
        ),
      },
      m.created_at,
      m.updated_at,
    );
  }

  mapIdentifier(accountId: string, typeId: string, i: CkIdentifier): ResourceInstance {
    return this.instance(
      accountId,
      typeId,
      str(i.id),
      str(i.identifier),
      {
        identifier: str(i.identifier),
        identifierType: str(i.identifier_type),
        createdAt: iso(i.created_at),
      },
      {},
      i.created_at,
      i.updated_at,
    );
  }

  mapInvitation(accountId: string, i: CkInvitation): ResourceInstance {
    return this.instance(
      accountId,
      "invitation",
      str(i.id),
      str(i.email_address),
      {
        email: str(i.email_address),
        status: str(i.status),
        url: str(i.url),
        expiresAt: iso(i.expires_at),
        createdAt: iso(i.created_at),
      },
      {},
      i.created_at,
      i.updated_at,
    );
  }

  mapRedirectUrl(accountId: string, r: CkRedirectUrl): ResourceInstance {
    return this.instance(
      accountId,
      "redirect-url",
      str(r.id),
      str(r.url),
      { url: str(r.url), createdAt: iso(r.created_at) },
      { url: str(r.url) },
      r.created_at,
      r.updated_at,
    );
  }

  // -------------------------------------------------------------------------
  // Preflight, metrics, stats
  // -------------------------------------------------------------------------

  async verifyCredentials(): Promise<PreflightResult> {
    const checks: PreflightCapabilityCheck[] = [];
    let identity = "";
    try {
      const instance = await this.api.request<CkInstance>("/instance");
      identity = `${str(instance.environment_type)} instance ${str(instance.id)}`;
      checks.push({ capabilityId: "instance", status: "ok" });
    } catch (error) {
      const status = (error as { status?: number }).status;
      checks.push(
        status === 401 || status === 403
          ? {
              capabilityId: "instance",
              status: "missing",
              missingPermissions: [
                { id: "secret-key", label: "A valid secret key for this instance" },
              ],
              message: (error as Error).message,
            }
          : { capabilityId: "instance", status: "unknown", message: (error as Error).message },
      );
    }
    return { checks, ...(identity ? { identity } : {}) };
  }

  /**
   * Clerk has no analytics API; `GET /users/count` takes `created_at_after`/
   * `_before` and `last_active_at_since`, so new users per day are counted
   * one bucket per call (capped at 31 buckets).
   */
  async fetchMetricSeries(
    resourceTypeId: string,
    _resourceId: string,
    _accountId: string,
    timeRange?: { startMs: number; endMs: number },
  ): Promise<MetricSeries[]> {
    if (resourceTypeId !== "instance") return [];
    const endMs = timeRange?.endMs ?? Date.now();
    const startMs = timeRange?.startMs ?? endMs - METRICS_DEFAULT_RANGE_MS;
    const span = Math.max(endMs - startMs, DAY_MS);
    const bucketMs = Math.max(DAY_MS, Math.ceil(span / 31 / DAY_MS) * DAY_MS);
    const buckets: number[] = [];
    for (let at = startMs; at < endMs; at += bucketMs) buckets.push(at);
    const counts = await Promise.all(
      buckets.map((at) =>
        this.api
          .request<{ total_count?: number }>("/users/count", {
            query: { created_at_after: at, created_at_before: Math.min(at + bucketMs, endMs) },
          })
          .then((b) => b.total_count ?? 0),
      ),
    );
    const [day, week, month] = await Promise.all(
      [DAY_MS, 7 * DAY_MS, 30 * DAY_MS].map((window) =>
        this.api
          .request<{ total_count?: number }>("/users/count", {
            query: { last_active_at_since: endMs - window },
          })
          .then((b) => b.total_count ?? 0)
          .catch(() => 0),
      ),
    );
    return [
      {
        label: "New users",
        unit: "count",
        points: buckets.map((timestamp, i) => ({ timestamp, value: counts[i] ?? 0 })),
      },
      {
        label: "Active users (24h)",
        unit: "count",
        points: [{ timestamp: endMs, value: day ?? 0 }],
      },
      {
        label: "Active users (7d)",
        unit: "count",
        points: [{ timestamp: endMs, value: week ?? 0 }],
      },
      {
        label: "Active users (30d)",
        unit: "count",
        points: [{ timestamp: endMs, value: month ?? 0 }],
      },
    ];
  }

  async fetchDashboardStats(resourceTypeId: string, resourceId: string): Promise<DashboardStat[]> {
    if (resourceTypeId === "instance") {
      const [total, active, banned] = await Promise.all(
        [{}, { last_active_at_since: Date.now() - 30 * DAY_MS }, { banned: true }].map((query) =>
          this.api
            .request<{ total_count?: number }>("/users/count", { query })
            .then((b) => b.total_count)
            .catch(() => undefined),
        ),
      );
      const show = (n: number | undefined) => (n === undefined ? "—" : String(n));
      return [
        { label: "Users", value: show(total) },
        { label: "Active (30d)", value: show(active) },
        { label: "Banned", value: show(banned) },
      ];
    }
    if (resourceTypeId === "organization") {
      const org = await this.api.request<CkOrganization>(
        `/organizations/${encodeURIComponent(externalIdOf(resourceId))}`,
        {
          query: { include_members_count: true },
        },
      );
      return [
        { label: "Members", value: str(org.members_count ?? "—") },
        { label: "Pending invitations", value: str(org.pending_invitations_count ?? 0) },
      ];
    }
    return [];
  }

  // -------------------------------------------------------------------------
  // Instance settings editor
  // -------------------------------------------------------------------------

  async getManifest(): Promise<string> {
    // There is no GET for restrictions; an empty PATCH changes nothing and returns the current values.
    const [restrictions, org, protect] = await Promise.all([
      this.api.request<CkRestrictions>("/instance/restrictions", { method: "PATCH", body: {} }),
      this.api.request<CkOrgSettings>("/instance/organization_settings"),
      this.api.request<CkProtect>("/instance/protect").catch(() => undefined),
    ]);
    const toggle = (
      id: string,
      label: string,
      group: string,
      value: boolean | undefined,
      description?: string,
    ): SettingDescriptor => ({
      id,
      label,
      group,
      control: "toggle",
      value: value ? "on" : "off",
      ...(description ? { description } : {}),
    });
    const settings: SettingDescriptor[] = [
      toggle(
        "restrictions.allowlist",
        "Allowlist",
        "Restrictions",
        restrictions.allowlist,
        "Only identifiers on the allowlist can sign up.",
      ),
      toggle(
        "restrictions.blocklist",
        "Blocklist",
        "Restrictions",
        restrictions.blocklist,
        "Identifiers on the blocklist cannot sign up or in.",
      ),
      toggle(
        "restrictions.block_email_subaddresses",
        "Block email subaddresses",
        "Restrictions",
        restrictions.block_email_subaddresses,
        "Reject addresses like name+tag@example.com.",
      ),
      toggle(
        "restrictions.block_disposable_email_domains",
        "Block disposable email domains",
        "Restrictions",
        restrictions.block_disposable_email_domains,
      ),
      toggle(
        "restrictions.allowlist_blocklist_disabled_on_sign_in",
        "Apply lists to sign-up only",
        "Restrictions",
        restrictions.allowlist_blocklist_disabled_on_sign_in,
      ),
      toggle("org.enabled", "Organizations", "Organizations", org.enabled),
      {
        id: "org.max_allowed_memberships",
        label: "Default member limit",
        group: "Organizations",
        control: "number",
        value: str(org.max_allowed_memberships ?? 0),
        description: "0 means unlimited.",
      },
      toggle(
        "org.admin_delete_enabled",
        "Admins can delete organizations",
        "Organizations",
        org.admin_delete_enabled,
      ),
      toggle("org.domains_enabled", "Verified domains", "Organizations", org.domains_enabled),
    ];
    if (protect) {
      settings.push(
        toggle(
          "protect.rules_enabled",
          "Protect rules",
          "Bot and abuse protection",
          protect.rules_enabled,
        ),
        toggle(
          "protect.specter_enabled",
          "Specter bot detection",
          "Bot and abuse protection",
          protect.specter_enabled,
        ),
      );
    }
    return JSON.stringify({ settings });
  }

  async applyManifest(_resourceId: string, _accountId: string, manifest: string): Promise<void> {
    const changes = JSON.parse(manifest) as Array<{ id: string; value: string }>;
    const groups: Record<string, Record<string, unknown>> = {
      restrictions: {},
      org: {},
      protect: {},
    };
    for (const { id, value } of changes) {
      const [group = "", key = ""] = id.split(".");
      const target = groups[group];
      if (!target || !key) continue;
      target[key] = key === "max_allowed_memberships" ? Number(value) : bool(value) === true;
    }
    if (Object.keys(groups["restrictions"]!).length > 0) {
      await this.api.request("/instance/restrictions", {
        method: "PATCH",
        body: groups["restrictions"],
      });
    }
    if (Object.keys(groups["org"]!).length > 0) {
      await this.api.request("/instance/organization_settings", {
        method: "PATCH",
        body: groups["org"],
      });
    }
    if (Object.keys(groups["protect"]!).length > 0) {
      await this.api.request("/instance/protect", { method: "PATCH", body: groups["protect"] });
    }
  }

  // -------------------------------------------------------------------------
  // Create
  // -------------------------------------------------------------------------

  private async userOptions(): Promise<SelectOption[]> {
    const users = await this.api
      .list<CkUser>("/users", { order_by: "-created_at" }, 500)
      .catch(() => [] as CkUser[]);
    return users.map((u) => ({
      id: str(u.id),
      label: primaryEmail(u) || str(u.username) || str(u.id),
    }));
  }

  async roleOptions(): Promise<SelectOption[]> {
    const roles = await this.api
      .list<CkOrgRole>("/organization_roles", {}, 500)
      .catch(() => [] as CkOrgRole[]);
    if (roles.length === 0) {
      return [
        { id: "org:admin", label: "Admin" },
        { id: "org:member", label: "Member" },
      ];
    }
    return roles.map((r) => ({
      id: str(r.key),
      label: str(r.name) || str(r.key),
      ...(r.description ? { description: r.description } : {}),
    }));
  }

  async getCreateConfig(typeId: string): Promise<CreateResourceConfig> {
    switch (typeId) {
      case "user":
        return {
          fields: [
            { key: "email", label: "Email", kind: "text", required: true },
            { key: "firstName", label: "First name", kind: "text", required: false },
            { key: "lastName", label: "Last name", kind: "text", required: false },
            {
              key: "username",
              label: "Username",
              kind: "text",
              required: false,
              description: "Only if usernames are enabled for the instance.",
            },
            {
              key: "password",
              label: "Password",
              kind: "password",
              required: false,
              description:
                "Leave blank for users who sign in with email codes, magic links, SSO or social accounts.",
            },
          ],
        };
      case "organization":
        return {
          fields: [
            { key: "name", label: "Name", kind: "text", required: true },
            {
              key: "slug",
              label: "Slug",
              kind: "text",
              required: false,
              description: "Generated from the name when blank.",
            },
            {
              key: "createdBy",
              label: "Owner",
              kind: "select",
              required: false,
              options: await this.userOptions(),
              description: "Becomes the organization's first admin. Optional.",
            },
            {
              key: "maxAllowedMemberships",
              label: "Member limit",
              kind: "number",
              required: false,
              minValue: 0,
              description: "0 for unlimited.",
            },
          ],
        };
      case "domain":
        return {
          fields: [
            {
              key: "name",
              label: "Satellite domain",
              kind: "text",
              required: true,
              placeholder: "satellite.example.com",
            },
            {
              key: "proxyUrl",
              label: "Proxy URL",
              kind: "text",
              required: false,
              placeholder: "https://satellite.example.com/__clerk",
            },
          ],
        };
      case "jwt-template":
        return {
          fields: [
            { key: "name", label: "Name", kind: "text", required: true, placeholder: "supabase" },
            {
              key: "claims",
              label: "Claims",
              kind: "code",
              codeLanguage: "json",
              required: true,
              defaultValue: '{\n  "email": "{{user.primary_email_address}}"\n}',
            },
            {
              key: "lifetime",
              label: "Lifetime (seconds)",
              kind: "number",
              required: false,
              defaultValue: "60",
              minValue: 30,
              maxValue: 315360000,
            },
            {
              key: "allowedClockSkew",
              label: "Allowed clock skew (seconds)",
              kind: "number",
              required: false,
              defaultValue: "5",
              minValue: 0,
              maxValue: 300,
            },
          ],
        };
      case "oauth-application":
        return {
          fields: [
            { key: "name", label: "Name", kind: "text", required: true },
            {
              key: "redirectUris",
              label: "Redirect URIs",
              kind: "string-list",
              required: true,
              addLabel: "+ Add URI",
            },
            {
              key: "scopes",
              label: "Scopes",
              kind: "text",
              required: false,
              defaultValue: "profile email",
            },
            {
              key: "public",
              label: "Client type",
              kind: "select",
              required: false,
              defaultValue: "false",
              options: [
                { id: "false", label: "Confidential (has a client secret)" },
                { id: "true", label: "Public (SPA or native, PKCE)" },
              ],
            },
          ],
        };
      case "enterprise-connection":
        return {
          fields: [
            { key: "name", label: "Name", kind: "text", required: true },
            {
              key: "provider",
              label: "Identity provider",
              kind: "select",
              required: true,
              defaultValue: "saml_okta",
              options: [
                { id: "saml_okta", label: "Okta Workforce (SAML)" },
                { id: "saml_microsoft", label: "Microsoft Entra ID (SAML)" },
                { id: "saml_google", label: "Google Workspace (SAML)" },
                { id: "saml_custom", label: "Custom SAML provider" },
              ],
            },
            {
              key: "domains",
              label: "Email domains",
              kind: "string-list",
              required: true,
              addLabel: "+ Add domain",
              placeholder: "example.com",
            },
            {
              key: "idpMetadataUrl",
              label: "IdP metadata URL",
              kind: "text",
              required: false,
              description:
                "Clerk reads the SSO URL, entity ID and certificate from it. Leave blank to configure the IdP later.",
            },
          ],
        };
      case "machine":
        return {
          fields: [
            {
              key: "name",
              label: "Name",
              kind: "text",
              required: true,
              placeholder: "billing-worker",
            },
            {
              key: "defaultTokenTtl",
              label: "Token TTL (seconds)",
              kind: "number",
              required: false,
              defaultValue: "3600",
              minValue: 60,
            },
          ],
        };
      case "allowlist-identifier":
      case "blocklist-identifier":
        return {
          fields: [
            {
              key: "identifier",
              label: "Identifier",
              kind: "text",
              required: true,
              placeholder: "*@example.com",
              description:
                "An email address, a domain wildcard (*@example.com), a phone number or a Web3 wallet.",
            },
          ],
        };
      case "invitation":
        return {
          fields: [
            { key: "email", label: "Email", kind: "text", required: true },
            {
              key: "redirectUrl",
              label: "Redirect URL",
              kind: "text",
              required: false,
              description: "Where the invitation link lands, usually your sign-up page.",
            },
            {
              key: "expiresInDays",
              label: "Expires in (days)",
              kind: "number",
              required: false,
              defaultValue: "30",
              minValue: 1,
              maxValue: 365,
            },
          ],
        };
      case "redirect-url":
        return {
          fields: [
            {
              key: "url",
              label: "URL",
              kind: "text",
              required: true,
              placeholder: "myapp://oauth-callback",
            },
          ],
        };
      default:
        throw new Error(`Clerk plugin: cannot create resource type "${typeId}"`);
    }
  }

  async createResource(
    typeId: string,
    accountId: string,
    fields: Record<string, string>,
  ): Promise<ResourceInstance> {
    switch (typeId) {
      case "user": {
        const user = await this.api.request<CkUser>("/users", {
          method: "POST",
          body: {
            email_address: [fields["email"]],
            ...(fields["firstName"] ? { first_name: fields["firstName"] } : {}),
            ...(fields["lastName"] ? { last_name: fields["lastName"] } : {}),
            ...(fields["username"] ? { username: fields["username"] } : {}),
            ...(fields["password"]
              ? { password: fields["password"] }
              : { skip_password_requirement: true }),
          },
        });
        return this.mapUser(accountId, user);
      }
      case "organization": {
        const org = await this.api.request<CkOrganization>("/organizations", {
          method: "POST",
          body: {
            name: fields["name"],
            ...(fields["slug"] ? { slug: fields["slug"] } : {}),
            ...(fields["createdBy"] ? { created_by: fields["createdBy"] } : {}),
            ...(fields["maxAllowedMemberships"]
              ? { max_allowed_memberships: Number(fields["maxAllowedMemberships"]) }
              : {}),
          },
        });
        return this.mapOrganization(accountId, org);
      }
      case "domain": {
        const domain = await this.api.request<CkDomain>("/domains", {
          method: "POST",
          body: {
            name: fields["name"],
            is_satellite: true,
            ...(fields["proxyUrl"] ? { proxy_url: fields["proxyUrl"] } : {}),
          },
        });
        return this.mapDomain(accountId, domain);
      }
      case "jwt-template": {
        let claims: unknown;
        try {
          claims = JSON.parse(fields["claims"] || "{}");
        } catch {
          throw Object.assign(new Error("Clerk plugin: claims must be valid JSON"), {
            status: 400,
          });
        }
        const template = await this.api.request<CkJwtTemplate>("/jwt_templates", {
          method: "POST",
          body: {
            name: fields["name"],
            claims,
            ...(fields["lifetime"] ? { lifetime: Number(fields["lifetime"]) } : {}),
            ...(fields["allowedClockSkew"]
              ? { allowed_clock_skew: Number(fields["allowedClockSkew"]) }
              : {}),
          },
        });
        return this.mapJwtTemplate(accountId, template);
      }
      case "oauth-application": {
        const app = await this.api.request<CkOAuthApp & { client_secret?: string }>(
          "/oauth_applications",
          {
            method: "POST",
            body: {
              name: fields["name"],
              redirect_uris: list(fields["redirectUris"]),
              scopes: fields["scopes"] || "profile email",
              public: fields["public"] === "true",
            },
          },
        );
        return this.mapOAuthApp(accountId, app);
      }
      case "enterprise-connection": {
        const connection = await this.api.request<CkEnterpriseConnection>(
          "/enterprise_connections",
          {
            method: "POST",
            body: {
              name: fields["name"],
              provider: fields["provider"] || "saml_custom",
              domains: list(fields["domains"]),
              ...(fields["idpMetadataUrl"]
                ? { saml: { idp_metadata_url: fields["idpMetadataUrl"] } }
                : {}),
            },
          },
        );
        return this.mapEnterpriseConnection(accountId, connection);
      }
      case "machine": {
        const machine = await this.api.request<CkMachine>("/machines", {
          method: "POST",
          body: {
            name: fields["name"],
            ...(fields["defaultTokenTtl"]
              ? { default_token_ttl: Number(fields["defaultTokenTtl"]) }
              : {}),
          },
        });
        return this.mapMachine(accountId, machine);
      }
      case "allowlist-identifier":
      case "blocklist-identifier": {
        const path =
          typeId === "allowlist-identifier" ? "/allowlist_identifiers" : "/blocklist_identifiers";
        const item = await this.api.request<CkIdentifier>(path, {
          method: "POST",
          body: {
            identifier: fields["identifier"],
            ...(typeId === "allowlist-identifier" ? { notify: false } : {}),
          },
        });
        return this.mapIdentifier(accountId, typeId, item);
      }
      case "invitation": {
        const invitation = await this.api.request<CkInvitation>("/invitations", {
          method: "POST",
          body: {
            email_address: fields["email"],
            ...(fields["redirectUrl"] ? { redirect_url: fields["redirectUrl"] } : {}),
            ...(fields["expiresInDays"]
              ? { expires_in_days: Number(fields["expiresInDays"]) }
              : {}),
            notify: true,
          },
        });
        return this.mapInvitation(accountId, invitation);
      }
      case "redirect-url": {
        const url = await this.api.request<CkRedirectUrl>("/redirect_urls", {
          method: "POST",
          body: { url: fields["url"] },
        });
        return this.mapRedirectUrl(accountId, url);
      }
      default:
        throw new Error(`Clerk plugin: cannot create resource type "${typeId}"`);
    }
  }

  // -------------------------------------------------------------------------
  // Update / delete
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
      case "instance": {
        const body: Record<string, unknown> = {};
        if (has("allowedOrigins")) body["allowed_origins"] = list(fields["allowedOrigins"]);
        if (fields["supportEmail"]) body["support_email"] = fields["supportEmail"];
        if (Object.keys(body).length > 0)
          await this.api.request("/instance", { method: "PATCH", body });
        return this.instanceResource(accountId);
      }
      case "user": {
        const body: Record<string, unknown> = {};
        if (has("firstName")) body["first_name"] = fields["firstName"];
        if (has("lastName")) body["last_name"] = fields["lastName"];
        if (has("username")) body["username"] = fields["username"];
        if (has("externalId")) body["external_id"] = fields["externalId"];
        if (fields["password"]) body["password"] = fields["password"];
        return this.mapUser(
          accountId,
          await this.api.request<CkUser>(`/users/${id}`, { method: "PATCH", body }),
        );
      }
      case "organization": {
        const body: Record<string, unknown> = {};
        if (has("name")) body["name"] = fields["name"];
        if (has("slug")) body["slug"] = fields["slug"];
        if (fields["maxAllowedMemberships"])
          body["max_allowed_memberships"] = Number(fields["maxAllowedMemberships"]);
        const del = bool(fields["adminDeleteEnabled"]);
        if (del !== undefined) body["admin_delete_enabled"] = del;
        await this.api.request(`/organizations/${id}`, { method: "PATCH", body });
        return this.getResource(typeId, resourceId, accountId);
      }
      case "domain":
        await this.api.request(`/domains/${id}`, {
          method: "PATCH",
          body: { proxy_url: fields["proxyUrl"] ?? "" },
        });
        return this.getResource(typeId, resourceId, accountId);
      case "jwt-template": {
        const current = await this.api.request<CkJwtTemplate>(`/jwt_templates/${id}`);
        let claims: unknown = current.claims ?? {};
        if (has("claims")) {
          try {
            claims = JSON.parse(fields["claims"] || "{}");
          } catch {
            throw Object.assign(new Error("Clerk plugin: claims must be valid JSON"), {
              status: 400,
            });
          }
        }
        // PATCH requires name and claims every time.
        const body: Record<string, unknown> = { name: fields["name"] ?? current.name, claims };
        if (fields["lifetime"]) body["lifetime"] = Number(fields["lifetime"]);
        if (fields["allowedClockSkew"])
          body["allowed_clock_skew"] = Number(fields["allowedClockSkew"]);
        return this.mapJwtTemplate(
          accountId,
          await this.api.request<CkJwtTemplate>(`/jwt_templates/${id}`, { method: "PATCH", body }),
        );
      }
      case "oauth-application": {
        const body: Record<string, unknown> = {};
        if (has("name")) body["name"] = fields["name"];
        if (has("redirectUris")) body["redirect_uris"] = list(fields["redirectUris"]);
        if (has("scopes")) body["scopes"] = fields["scopes"];
        const consent = bool(fields["consentScreenEnabled"]);
        if (consent !== undefined) body["consent_screen_enabled"] = consent;
        const pkce = bool(fields["pkceRequired"]);
        if (pkce !== undefined) body["pkce_required"] = pkce;
        return this.mapOAuthApp(
          accountId,
          await this.api.request<CkOAuthApp>(`/oauth_applications/${id}`, {
            method: "PATCH",
            body,
          }),
        );
      }
      case "enterprise-connection": {
        const body: Record<string, unknown> = {};
        if (has("name")) body["name"] = fields["name"];
        if (has("domains")) body["domains"] = list(fields["domains"]);
        const active = bool(fields["active"]);
        if (active !== undefined) body["active"] = active;
        const sync = bool(fields["syncUserAttributes"]);
        if (sync !== undefined) body["sync_user_attributes"] = sync;
        return this.mapEnterpriseConnection(
          accountId,
          await this.api.request<CkEnterpriseConnection>(`/enterprise_connections/${id}`, {
            method: "PATCH",
            body,
          }),
        );
      }
      case "machine": {
        const body: Record<string, unknown> = {};
        if (has("name")) body["name"] = fields["name"];
        if (fields["defaultTokenTtl"])
          body["default_token_ttl"] = Number(fields["defaultTokenTtl"]);
        return this.mapMachine(
          accountId,
          await this.api.request<CkMachine>(`/machines/${id}`, { method: "PATCH", body }),
        );
      }
      default:
        throw new Error(`Clerk plugin: cannot update resource type "${typeId}"`);
    }
  }

  async deleteResource(typeId: string, resourceId: string): Promise<void> {
    const id = encodeURIComponent(externalIdOf(resourceId));
    if (typeId === "invitation") {
      await this.api.request(`/invitations/${id}/revoke`, { method: "POST" });
      return;
    }
    const paths: Record<string, string> = {
      user: `/users/${id}`,
      organization: `/organizations/${id}`,
      domain: `/domains/${id}`,
      "jwt-template": `/jwt_templates/${id}`,
      "oauth-application": `/oauth_applications/${id}`,
      "enterprise-connection": `/enterprise_connections/${id}`,
      machine: `/machines/${id}`,
      "allowlist-identifier": `/allowlist_identifiers/${id}`,
      "blocklist-identifier": `/blocklist_identifiers/${id}`,
      "redirect-url": `/redirect_urls/${id}`,
    };
    const path = paths[typeId];
    if (!path) throw new Error(`Clerk plugin: cannot delete resource type "${typeId}"`);
    await this.api.request(path, { method: "DELETE" });
  }

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  async invokeAction(typeId: string, resourceId: string, actionId: string): Promise<void> {
    const id = encodeURIComponent(externalIdOf(resourceId));
    if (typeId === "user") {
      const simple: Record<string, [string, string]> = {
        ban: ["POST", "ban"],
        unban: ["POST", "unban"],
        lock: ["POST", "lock"],
        unlock: ["POST", "unlock"],
        "disable-mfa": ["DELETE", "mfa"],
      };
      const step = simple[actionId];
      if (step) {
        await this.api.request(`/users/${id}/${step[1]}`, { method: step[0] });
        return;
      }
      if (actionId === "revoke-sessions") {
        const sessions = await this.api.list<CkSession>("/sessions", {
          user_id: externalIdOf(resourceId),
          status: "active",
        });
        for (const session of sessions) {
          await this.api.request(`/sessions/${encodeURIComponent(str(session.id))}/revoke`, {
            method: "POST",
          });
        }
        return;
      }
    }
    if (typeId === "instance" && actionId === "enable-webhooks") {
      await this.api.request("/webhooks/svix", { method: "POST" });
      return;
    }
    throw new Error(`Clerk plugin: unknown action "${actionId}" for type "${typeId}"`);
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
      if (!value) throw new Error(`Clerk plugin: choose ${what}`);
      return value;
    };
    switch (`${typeId}:${command}`) {
      case "user:revoke-session":
        return this.api.request(
          `/sessions/${encodeURIComponent(need("sessionId", "a session"))}/revoke`,
          { method: "POST" },
        );
      case "user:add-to-organization":
        return this.api.request(
          `/organizations/${encodeURIComponent(need("organizationId", "an organization"))}/memberships`,
          {
            method: "POST",
            body: { user_id: raw, role: need("role", "a role") },
          },
        );
      case "user:remove-from-organization":
        return this.api.request(
          `/organizations/${encodeURIComponent(need("organizationId", "an organization"))}/memberships/${id}`,
          {
            method: "DELETE",
          },
        );
      case "organization:add-member":
        return this.api.request(`/organizations/${id}/memberships`, {
          method: "POST",
          body: { user_id: need("userId", "a user"), role: need("role", "a role") },
        });
      case "organization:change-role":
        return this.api.request(
          `/organizations/${id}/memberships/${encodeURIComponent(need("userId", "a member"))}`,
          {
            method: "PATCH",
            body: { role: need("role", "a role") },
          },
        );
      case "organization:remove-member":
        return this.api.request(
          `/organizations/${id}/memberships/${encodeURIComponent(need("userId", "a member"))}`,
          { method: "DELETE" },
        );
      case "organization:invite":
        return this.api.request(`/organizations/${id}/invitations`, {
          method: "POST",
          body: { email_address: need("email", "an email address"), role: need("role", "a role") },
        });
      case "organization:revoke-invitation":
        return this.api.request(
          `/organizations/${id}/invitations/${encodeURIComponent(need("invitationId", "an invitation"))}/revoke`,
          {
            method: "POST",
            body: {},
          },
        );
      case "machine:allow-machine":
        return this.api.request(`/machines/${id}/scopes`, {
          method: "POST",
          body: { to_machine_id: need("machineId", "a machine") },
        });
      case "machine:disallow-machine":
        return this.api.request(
          `/machines/${id}/scopes/${encodeURIComponent(need("machineId", "a machine"))}`,
          { method: "DELETE" },
        );
      default:
        throw new Error(`Clerk plugin: unknown command "${command}" for type "${typeId}"`);
    }
  }

  async exportCredential(
    typeId: string,
    resourceId: string,
    _accountId: string,
    formatId: string,
  ): Promise<CredentialExport> {
    const id = encodeURIComponent(externalIdOf(resourceId));
    if (typeId === "instance" && formatId === "webhooks-dashboard") {
      const body = await this.api
        .request<{ svix_url?: string }>("/webhooks/svix_url", { method: "POST" })
        .catch((error: { status?: number }) => {
          if (error.status === 404 || error.status === 400) {
            throw Object.assign(
              new Error(
                "Clerk plugin: webhooks are not enabled for this instance yet. Use Enable webhooks first.",
              ),
              {
                status: error.status,
              },
            );
          }
          throw error;
        });
      const url = str(body.svix_url);
      return {
        content: url,
        filename: "clerk-webhooks-dashboard.txt",
        mimeType: "text/plain",
        fields: [
          {
            label: "Webhooks dashboard",
            value: url,
            sensitive: true,
            hint: "Short-lived sign-in link",
          },
        ],
        warning:
          "Anyone with this link can manage the instance's webhook endpoints until it expires.",
      };
    }
    if (typeId === "oauth-application" && formatId === "rotate-secret") {
      const body = await this.api.request<{ client_id?: string; client_secret?: string }>(
        `/oauth_applications/${id}/rotate_secret`,
        {
          method: "POST",
        },
      );
      const secret = str(body.client_secret);
      if (!secret) throw new Error("Clerk plugin: Clerk returned no client secret");
      return {
        content: `CLIENT_ID=${str(body.client_id)}\nCLIENT_SECRET=${secret}\n`,
        filename: "clerk-oauth-application.env",
        mimeType: "text/plain",
        fields: [
          { label: "Client ID", value: str(body.client_id) },
          { label: "Client secret", value: secret, sensitive: true, hint: "Only shown once" },
        ],
        warning: "The previous client secret stopped working. Update every client that used it.",
      };
    }
    if (
      typeId === "machine" &&
      (formatId === "rotate-secret-grace" || formatId === "rotate-secret-now")
    ) {
      const body = await this.api.request<{ secret?: string }>(
        `/machines/${id}/secret_key/rotate`,
        {
          method: "POST",
          body: { previous_token_ttl: formatId === "rotate-secret-grace" ? 3600 : 0 },
        },
      );
      const secret = str(body.secret);
      return {
        content: secret,
        filename: "clerk-machine-secret.txt",
        mimeType: "text/plain",
        fields: [{ label: "Machine secret key", value: secret, sensitive: true }],
        warning:
          formatId === "rotate-secret-grace"
            ? "The previous secret keeps working for one hour."
            : "The previous secret stopped working immediately.",
      };
    }
    throw new Error(`Clerk plugin: unknown credential format "${formatId}"`);
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
        const [sessions, memberships, orgs, roles] = await Promise.all([
          this.api
            .list<CkSession>("/sessions", { user_id: raw, status: "active" }, 500)
            .catch(() => [] as CkSession[]),
          this.api
            .list<CkMembership>(`/users/${id}/organization_memberships`, {}, 500)
            .catch(() => [] as CkMembership[]),
          this.api
            .list<CkOrganization>("/organizations", {}, 500)
            .catch(() => [] as CkOrganization[]),
          this.roleOptions(),
        ]);
        extra["__sessions__"] = JSON.stringify(
          sessions.map((s) => ({
            id: str(s.id),
            lastActive: iso(s.last_active_at),
            expires: iso(s.expire_at),
            client: str(s.client_id),
          })),
        );
        extra["__memberships__"] = JSON.stringify(
          memberships.map((m) => ({
            id: str(m.organization?.id),
            label: str(m.organization?.name),
            role: str(m.role),
          })),
        );
        extra["__orgOptions__"] = JSON.stringify(
          orgs.map((o) => ({ id: str(o.id), label: str(o.name) })),
        );
        extra["__roleOptions__"] = JSON.stringify(roles);
        break;
      }
      case "organization": {
        const [members, users, roles, invitations] = await Promise.all([
          this.api
            .list<CkMembership>(`/organizations/${id}/memberships`, {}, 1000)
            .catch(() => [] as CkMembership[]),
          this.userOptions(),
          this.roleOptions(),
          this.api
            .list<CkInvitation>(`/organizations/${id}/invitations`, { status: "pending" }, 500)
            .catch(() => [] as CkInvitation[]),
        ]);
        extra["__members__"] = JSON.stringify(
          members.map((m) => ({
            id: str(m.public_user_data?.user_id),
            label: str(m.public_user_data?.identifier) || str(m.public_user_data?.user_id),
            role: str(m.role),
          })),
        );
        extra["__userOptions__"] = JSON.stringify(users);
        extra["__roleOptions__"] = JSON.stringify(roles);
        extra["__invitations__"] = JSON.stringify(
          invitations.map((i) => ({
            id: str(i.id),
            label: str(i.email_address),
            role: str(i.role),
          })),
        );
        break;
      }
      case "machine": {
        const machines = await this.api
          .list<CkMachine>("/machines", {}, 500)
          .catch(() => [] as CkMachine[]);
        extra["__machineOptions__"] = JSON.stringify(
          machines.filter((m) => m.id !== raw).map((m) => ({ id: str(m.id), label: str(m.name) })),
        );
        break;
      }
      default:
        return resource;
    }
    return { ...resource, resolvedOutputs: { ...resource.resolvedOutputs, ...extra } };
  }

  renderDetail(resource: ResourceInstance): DetailViewSchema {
    return renderDetail(resource);
  }

  renderSidebarItem(resource: ResourceInstance): SidebarItemSchema {
    return renderSidebarItem(resource);
  }
}
