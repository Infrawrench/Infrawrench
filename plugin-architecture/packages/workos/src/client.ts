import type {
  CreateFieldConfig,
  CreateResourceConfig,
  DashboardStat,
  DetailViewSchema,
  HostServices,
  PluginClient,
  ResourceInstance,
  ResourceStatus,
  SidebarItemSchema,
} from "@infrawrench/plugin-base";
import { jsonRestFetch } from "@infrawrench/plugin-base";

const BASE_URL = "https://api.workos.com";

/** WorkOS list page size — the API caps `limit` at 100. */
const PAGE_SIZE = 100;

/** Hard cap on cursor-following so a huge environment can't hang a sync. */
const MAX_LIST_PAGES = 20;

// ---------------------------------------------------------------------------
// WorkOS API shapes — verified against the official OpenAPI spec
// (https://github.com/workos/openapi-spec, spec/open-api-spec.yaml).
// ---------------------------------------------------------------------------

/** Standard WorkOS list envelope: `{object: "list", data, list_metadata}`. */
interface WosList<T> {
  object?: string;
  data?: T[];
  list_metadata?: { before?: string | null; after?: string | null };
}

interface WosOrganizationDomain {
  domain?: string;
  state?: string;
}

interface WosOrganization {
  id?: string;
  name?: string;
  domains?: WosOrganizationDomain[];
  external_id?: string | null;
  created_at?: string;
  updated_at?: string;
}

interface WosUser {
  id?: string;
  email?: string;
  email_verified?: boolean;
  first_name?: string | null;
  last_name?: string | null;
  profile_picture_url?: string | null;
  external_id?: string | null;
  last_sign_in_at?: string | null;
  created_at?: string;
  updated_at?: string;
}

interface WosMembership {
  id?: string;
  user_id?: string;
  organization_id?: string;
  organization_name?: string;
  role?: { slug?: string };
  roles?: Array<{ slug?: string }>;
  status?: string;
  directory_managed?: boolean;
  created_at?: string;
  updated_at?: string;
}

interface WosInvitation {
  id?: string;
  email?: string;
  state?: string;
  role_slug?: string | null;
  expires_at?: string;
  accepted_at?: string | null;
  revoked_at?: string | null;
  inviter_user_id?: string | null;
  organization_id?: string | null;
  accept_invitation_url?: string;
  created_at?: string;
  updated_at?: string;
}

interface WosConnection {
  id?: string;
  organization_id?: string;
  connection_type?: string;
  name?: string;
  state?: string;
  domains?: Array<{ domain?: string }>;
  created_at?: string;
  updated_at?: string;
}

interface WosDirectory {
  id?: string;
  organization_id?: string;
  name?: string;
  type?: string;
  state?: string;
  external_key?: string;
  created_at?: string;
  updated_at?: string;
}

interface WosDirectoryUser {
  id?: string;
  directory_id?: string;
  organization_id?: string;
  idp_id?: string;
  email?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  created_at?: string;
  updated_at?: string;
}

interface WosDirectoryGroup {
  id?: string;
  directory_id?: string;
  organization_id?: string;
  idp_id?: string;
  name?: string;
  created_at?: string;
  updated_at?: string;
}

interface WosRole {
  id?: string;
  slug?: string;
  name?: string;
  description?: string | null;
  type?: string;
  permissions?: string[];
  created_at?: string;
  updated_at?: string;
}

interface WosWebhookEndpoint {
  id?: string;
  endpoint_url?: string;
  secret?: string;
  status?: string;
  events?: string[];
  created_at?: string;
  updated_at?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function externalIdOf(resourceId: string): string {
  return resourceId.split(":").slice(2).join(":");
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function membershipStatusDot(status: string): ResourceStatus {
  switch (status) {
    case "active":
      return "healthy";
    case "inactive":
      return "degraded";
    case "pending":
      return "provisioning";
    default:
      return "info";
  }
}

function invitationStateDot(state: string): ResourceStatus {
  switch (state) {
    case "accepted":
      return "healthy";
    case "pending":
      return "provisioning";
    case "expired":
      return "error";
    case "revoked":
      return "degraded";
    default:
      return "info";
  }
}

function connectionStateDot(state: string): ResourceStatus {
  switch (state) {
    case "active":
      return "healthy";
    case "validating":
      return "provisioning";
    case "inactive":
      return "degraded";
    default:
      return "info";
  }
}

function directoryStateDot(state: string): ResourceStatus {
  switch (state) {
    case "linked":
      return "healthy";
    case "validating":
      return "provisioning";
    case "invalid_credentials":
      return "error";
    case "unlinked":
    case "deleting":
      return "degraded";
    default:
      return "info";
  }
}

/**
 * WorkOS plugin client.
 *
 * Auth is `Authorization: Bearer sk_…` against https://api.workos.com. Every
 * list endpoint uses the standard `{object: "list", data, list_metadata}`
 * envelope with `after` cursor pagination, capped at `limit=100` per page.
 */
export class WorkosClient implements PluginClient {
  private readonly apiKey: string;
  private readonly caCert: string;
  private readonly services: HostServices | undefined;

  constructor(credentials: Record<string, string>, services?: HostServices) {
    const apiKey = credentials["apiKey"];
    if (!apiKey) throw new Error("WorkOS plugin: missing apiKey credential");
    this.apiKey = apiKey;
    this.caCert = credentials["caCert"] ?? "";
    this.services = services;
  }

  private get authHeaders(): Record<string, string> {
    return { Authorization: `Bearer ${this.apiKey}` };
  }

  private async fetch<T>(path: string, options?: RequestInit): Promise<T> {
    return jsonRestFetch<T>({
      vendor: "WorkOS",
      url: `${BASE_URL}${path}`,
      errorPath: path,
      headers: { ...this.authHeaders, Accept: "application/json" },
      ...(options ? { init: options } : {}),
      ...(this.caCert ? { caCert: this.caCert } : {}),
      ...(this.services?.http ? { http: this.services.http } : {}),
    });
  }

  /**
   * Issue a request whose success response carries no JSON body — WorkOS
   * DELETEs answer 200/202/204 with an empty body, which `jsonRestFetch`'s
   * direct-fetch path would try to `JSON.parse`.
   */
  private async requestVoid(path: string, method: string): Promise<void> {
    const url = `${BASE_URL}${path}`;
    const headers = { ...this.authHeaders, Accept: "application/json" };
    if (this.services?.http) {
      const result = await this.services.http.request({
        url,
        method,
        headers,
        ...(this.caCert ? { caCert: this.caCert } : {}),
      });
      if (result.status < 200 || result.status >= 300) {
        throw new Error(`WorkOS API error ${result.status} for ${path}: ${result.body}`);
      }
      return;
    }

    const res = await fetch(url, { method, headers });
    if (!res.ok) {
      throw new Error(`WorkOS API error ${res.status} for ${path}: ${await res.text()}`);
    }
  }

  /**
   * Follow the `list_metadata.after` cursor until the API stops returning one
   * (bounded by MAX_LIST_PAGES). `params` are merged into every page request.
   */
  private async paginate<T>(path: string, params: Record<string, string> = {}): Promise<T[]> {
    const out: T[] = [];
    let after = "";

    for (let page = 0; page < MAX_LIST_PAGES; page++) {
      const query = new URLSearchParams({ ...params, limit: String(PAGE_SIZE) });
      if (after) query.set("after", after);
      const body = await this.fetch<WosList<T>>(`${path}?${query.toString()}`);
      const items = body.data ?? [];
      out.push(...items);
      after = str(body.list_metadata?.after);
      if (!after || items.length === 0) break;
    }

    return out;
  }

  private async fetchOrganizations(): Promise<WosOrganization[]> {
    // GET /organizations — cursor-paginated list.
    return this.paginate<WosOrganization>("/organizations");
  }

  /**
   * Run `load` once per organization, tolerating per-org failures — one org
   * the key can't read must not empty the whole listing.
   */
  private async listForEachOrganization<T>(
    load: (organizationId: string) => Promise<T[]>,
  ): Promise<T[]> {
    const orgs = await this.fetchOrganizations();
    const ids = orgs.map((org) => str(org.id)).filter(Boolean);
    const settled = await Promise.allSettled(ids.map((id) => load(id)));
    return settled.flatMap((result) => (result.status === "fulfilled" ? result.value : []));
  }

  /** Map user_id → email so memberships can be labelled readably. */
  private async fetchUserEmailMap(): Promise<Map<string, string>> {
    const users = await this.paginate<WosUser>("/user_management/users").catch(
      () => [] as WosUser[],
    );
    const map = new Map<string, string>();
    for (const user of users) {
      if (user.id && user.email) map.set(user.id, user.email);
    }
    return map;
  }

  // -------------------------------------------------------------------------
  // Listing
  // -------------------------------------------------------------------------

  async listResources(typeId: string, accountId: string): Promise<ResourceInstance[]> {
    switch (typeId) {
      case "organization": {
        const orgs = await this.fetchOrganizations();
        return orgs.map((org) => this.mapOrganization(accountId, org));
      }
      case "user": {
        const users = await this.paginate<WosUser>("/user_management/users");
        return users.map((user) => this.mapUser(accountId, user));
      }
      case "organization-membership": {
        // GET /user_management/organization_memberships requires user_id or
        // organization_id, so fan out per org. Emails come from one users
        // sweep rather than a lookup per membership.
        const emails = await this.fetchUserEmailMap();
        const memberships = await this.listForEachOrganization((orgId) =>
          this.paginate<WosMembership>("/user_management/organization_memberships", {
            organization_id: orgId,
          }),
        );
        return memberships.map((m) => this.mapMembership(accountId, m, emails.get(str(m.user_id))));
      }
      case "invitation": {
        const invitations = await this.listForEachOrganization((orgId) =>
          this.paginate<WosInvitation>("/user_management/invitations", {
            organization_id: orgId,
          }),
        );
        return invitations.map((invitation) => this.mapInvitation(accountId, invitation));
      }
      case "connection": {
        const connections = await this.paginate<WosConnection>("/connections");
        return connections.map((connection) => this.mapConnection(accountId, connection));
      }
      case "directory": {
        const directories = await this.paginate<WosDirectory>("/directories");
        return directories.map((directory) => this.mapDirectory(accountId, directory));
      }
      case "directory-user": {
        const users = await this.listForEachDirectory((directoryId) =>
          this.paginate<WosDirectoryUser>("/directory_users", { directory: directoryId }),
        );
        return users.map((user) => this.mapDirectoryUser(accountId, user));
      }
      case "directory-group": {
        const groups = await this.listForEachDirectory((directoryId) =>
          this.paginate<WosDirectoryGroup>("/directory_groups", { directory: directoryId }),
        );
        return groups.map((group) => this.mapDirectoryGroup(accountId, group));
      }
      case "role": {
        // GET /authorization/roles — plain {data} list, no pagination.
        const body = await this.fetch<WosList<WosRole>>("/authorization/roles");
        return (body.data ?? []).map((role) => this.mapRole(accountId, role));
      }
      case "webhook-endpoint": {
        const endpoints = await this.paginate<WosWebhookEndpoint>("/webhook_endpoints");
        return endpoints.map((endpoint) => this.mapWebhookEndpoint(accountId, endpoint));
      }
      default:
        throw new Error(`WorkOS plugin: unknown resource type "${typeId}"`);
    }
  }

  private async listForEachDirectory<T>(load: (directoryId: string) => Promise<T[]>): Promise<T[]> {
    const directories = await this.paginate<WosDirectory>("/directories");
    const ids = directories.map((d) => str(d.id)).filter(Boolean);
    const settled = await Promise.allSettled(ids.map((id) => load(id)));
    return settled.flatMap((result) => (result.status === "fulfilled" ? result.value : []));
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
    switch (typeId) {
      case "organization": {
        const org = await this.fetch<WosOrganization>(`/organizations/${encodeURIComponent(id)}`);
        return this.mapOrganization(accountId, org);
      }
      case "user": {
        const user = await this.fetch<WosUser>(`/user_management/users/${encodeURIComponent(id)}`);
        return this.mapUser(accountId, user);
      }
      case "organization-membership": {
        const membership = await this.fetch<WosMembership>(
          `/user_management/organization_memberships/${encodeURIComponent(id)}`,
        );
        const email = await this.fetchUserEmail(str(membership.user_id));
        return this.mapMembership(accountId, membership, email);
      }
      case "invitation": {
        const invitation = await this.fetch<WosInvitation>(
          `/user_management/invitations/${encodeURIComponent(id)}`,
        );
        return this.mapInvitation(accountId, invitation);
      }
      case "connection": {
        const connection = await this.fetch<WosConnection>(
          `/connections/${encodeURIComponent(id)}`,
        );
        return this.mapConnection(accountId, connection);
      }
      case "directory": {
        const directory = await this.fetch<WosDirectory>(`/directories/${encodeURIComponent(id)}`);
        return this.mapDirectory(accountId, directory);
      }
      case "directory-user": {
        const user = await this.fetch<WosDirectoryUser>(
          `/directory_users/${encodeURIComponent(id)}`,
        );
        return this.mapDirectoryUser(accountId, user);
      }
      case "directory-group": {
        const group = await this.fetch<WosDirectoryGroup>(
          `/directory_groups/${encodeURIComponent(id)}`,
        );
        return this.mapDirectoryGroup(accountId, group);
      }
      case "role": {
        const role = await this.fetch<WosRole>(`/authorization/roles/${encodeURIComponent(id)}`);
        return this.mapRole(accountId, role);
      }
      case "webhook-endpoint": {
        // The spec documents PATCH/DELETE on /webhook_endpoints/{id} but no
        // GET, so re-list and pick the endpoint out.
        const endpoints = await this.paginate<WosWebhookEndpoint>("/webhook_endpoints");
        const match = endpoints.find((endpoint) => endpoint.id === id);
        if (!match) throw new Error(`WorkOS plugin: webhook endpoint "${id}" not found`);
        return this.mapWebhookEndpoint(accountId, match);
      }
      default:
        throw new Error(`WorkOS plugin: unknown resource type "${typeId}"`);
    }
  }

  private async fetchUserEmail(userId: string): Promise<string | undefined> {
    if (!userId) return undefined;
    try {
      const user = await this.fetch<WosUser>(
        `/user_management/users/${encodeURIComponent(userId)}`,
      );
      return str(user.email) || undefined;
    } catch {
      return undefined;
    }
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
    throw new Error(`WorkOS plugin: cannot resolve output "${outputKey}" for type "${typeId}"`);
  }

  // -------------------------------------------------------------------------
  // Mapping
  // -------------------------------------------------------------------------

  private mapOrganization(accountId: string, org: WosOrganization): ResourceInstance {
    const id = str(org.id);
    const createdAt = str(org.created_at) || new Date().toISOString();
    const domains = (org.domains ?? []).map((d) => str(d.domain)).filter(Boolean);

    return {
      id: `${accountId}:organization:${id}`,
      pluginId: "workos",
      resourceTypeId: "organization",
      accountId,
      displayName: str(org.name) || id,
      externalId: id,
      fields: {
        name: str(org.name),
        organizationId: id,
        externalId: str(org.external_id),
        domains: domains.join(", "),
        createdAt,
      },
      resolvedOutputs: {
        organizationId: id,
        organizationName: str(org.name),
        // renderDetail is synchronous — stash the per-domain states so the
        // Domains table can show verification status without a round trip.
        __domains__: JSON.stringify(org.domains ?? []),
      },
      secretStates: [],
      createdAt,
      updatedAt: str(org.updated_at) || createdAt,
    };
  }

  private mapUser(accountId: string, user: WosUser): ResourceInstance {
    const id = str(user.id);
    const createdAt = str(user.created_at) || new Date().toISOString();
    const fullName = [str(user.first_name), str(user.last_name)].filter(Boolean).join(" ");

    return {
      id: `${accountId}:user:${id}`,
      pluginId: "workos",
      resourceTypeId: "user",
      accountId,
      displayName: str(user.email) || fullName || id,
      externalId: id,
      fields: {
        email: str(user.email),
        firstName: str(user.first_name),
        lastName: str(user.last_name),
        emailVerified: user.email_verified === true,
        userId: id,
        externalId: str(user.external_id),
        lastSignInAt: str(user.last_sign_in_at),
        createdAt,
      },
      resolvedOutputs: { userId: id, email: str(user.email) },
      secretStates: [],
      createdAt,
      updatedAt: str(user.updated_at) || createdAt,
    };
  }

  private mapMembership(
    accountId: string,
    membership: WosMembership,
    userEmail?: string,
  ): ResourceInstance {
    const id = str(membership.id);
    const createdAt = str(membership.created_at) || new Date().toISOString();
    const organizationId = str(membership.organization_id);
    const role = str(membership.role?.slug);

    return {
      id: `${accountId}:organization-membership:${id}`,
      pluginId: "workos",
      resourceTypeId: "organization-membership",
      accountId,
      displayName: userEmail || str(membership.user_id) || id,
      externalId: id,
      fields: {
        userEmail: userEmail ?? "",
        userId: str(membership.user_id),
        organizationId,
        role,
        status: str(membership.status),
        directoryManaged: membership.directory_managed === true,
        createdAt,
      },
      resolvedOutputs: { membershipId: id },
      secretStates: [],
      ...(organizationId
        ? { parentResourceId: `${accountId}:organization:${organizationId}` }
        : {}),
      createdAt,
      updatedAt: str(membership.updated_at) || createdAt,
    };
  }

  private mapInvitation(accountId: string, invitation: WosInvitation): ResourceInstance {
    const id = str(invitation.id);
    const createdAt = str(invitation.created_at) || new Date().toISOString();
    const organizationId = str(invitation.organization_id);

    return {
      id: `${accountId}:invitation:${id}`,
      pluginId: "workos",
      resourceTypeId: "invitation",
      accountId,
      displayName: str(invitation.email) || id,
      externalId: id,
      fields: {
        email: str(invitation.email),
        state: str(invitation.state),
        roleSlug: str(invitation.role_slug),
        expiresAt: str(invitation.expires_at),
        acceptedAt: str(invitation.accepted_at),
        revokedAt: str(invitation.revoked_at),
        inviterUserId: str(invitation.inviter_user_id),
        organizationId,
        createdAt,
      },
      resolvedOutputs: {
        invitationId: id,
        acceptInvitationUrl: str(invitation.accept_invitation_url),
      },
      secretStates: [],
      ...(organizationId
        ? { parentResourceId: `${accountId}:organization:${organizationId}` }
        : {}),
      createdAt,
      updatedAt: str(invitation.updated_at) || createdAt,
    };
  }

  private mapConnection(accountId: string, connection: WosConnection): ResourceInstance {
    const id = str(connection.id);
    const createdAt = str(connection.created_at) || new Date().toISOString();
    const organizationId = str(connection.organization_id);
    const domains = (connection.domains ?? []).map((d) => str(d.domain)).filter(Boolean);

    return {
      id: `${accountId}:connection:${id}`,
      pluginId: "workos",
      resourceTypeId: "connection",
      accountId,
      displayName: str(connection.name) || str(connection.connection_type) || id,
      externalId: id,
      fields: {
        name: str(connection.name),
        connectionType: str(connection.connection_type),
        state: str(connection.state),
        domains: domains.join(", "),
        organizationId,
        createdAt,
      },
      resolvedOutputs: { connectionId: id },
      secretStates: [],
      ...(organizationId
        ? { parentResourceId: `${accountId}:organization:${organizationId}` }
        : {}),
      createdAt,
      updatedAt: str(connection.updated_at) || createdAt,
    };
  }

  private mapDirectory(accountId: string, directory: WosDirectory): ResourceInstance {
    const id = str(directory.id);
    const createdAt = str(directory.created_at) || new Date().toISOString();
    const organizationId = str(directory.organization_id);

    return {
      id: `${accountId}:directory:${id}`,
      pluginId: "workos",
      resourceTypeId: "directory",
      accountId,
      displayName: str(directory.name) || id,
      externalId: id,
      fields: {
        name: str(directory.name),
        type: str(directory.type),
        state: str(directory.state),
        organizationId,
        externalKey: str(directory.external_key),
        createdAt,
      },
      resolvedOutputs: { directoryId: id },
      secretStates: [],
      ...(organizationId
        ? { parentResourceId: `${accountId}:organization:${organizationId}` }
        : {}),
      createdAt,
      updatedAt: str(directory.updated_at) || createdAt,
    };
  }

  private mapDirectoryUser(accountId: string, user: WosDirectoryUser): ResourceInstance {
    const id = str(user.id);
    const createdAt = str(user.created_at) || new Date().toISOString();
    const directoryId = str(user.directory_id);
    const fullName = [str(user.first_name), str(user.last_name)].filter(Boolean).join(" ");

    return {
      id: `${accountId}:directory-user:${id}`,
      pluginId: "workos",
      resourceTypeId: "directory-user",
      accountId,
      displayName: str(user.email) || fullName || id,
      externalId: id,
      fields: {
        email: str(user.email),
        firstName: str(user.first_name),
        lastName: str(user.last_name),
        idpId: str(user.idp_id),
        directoryId,
        organizationId: str(user.organization_id),
        createdAt,
      },
      resolvedOutputs: { directoryUserId: id },
      secretStates: [],
      ...(directoryId ? { parentResourceId: `${accountId}:directory:${directoryId}` } : {}),
      createdAt,
      updatedAt: str(user.updated_at) || createdAt,
    };
  }

  private mapDirectoryGroup(accountId: string, group: WosDirectoryGroup): ResourceInstance {
    const id = str(group.id);
    const createdAt = str(group.created_at) || new Date().toISOString();
    const directoryId = str(group.directory_id);

    return {
      id: `${accountId}:directory-group:${id}`,
      pluginId: "workos",
      resourceTypeId: "directory-group",
      accountId,
      displayName: str(group.name) || id,
      externalId: id,
      fields: {
        name: str(group.name),
        idpId: str(group.idp_id),
        directoryId,
        organizationId: str(group.organization_id),
        createdAt,
      },
      resolvedOutputs: { directoryGroupId: id },
      secretStates: [],
      ...(directoryId ? { parentResourceId: `${accountId}:directory:${directoryId}` } : {}),
      createdAt,
      updatedAt: str(group.updated_at) || createdAt,
    };
  }

  private mapRole(accountId: string, role: WosRole): ResourceInstance {
    // Roles are addressed by slug in every other API call, so the slug is the
    // external id rather than the role_… id.
    const slug = str(role.slug);
    const createdAt = str(role.created_at) || new Date().toISOString();

    return {
      id: `${accountId}:role:${slug}`,
      pluginId: "workos",
      resourceTypeId: "role",
      accountId,
      displayName: str(role.name) || slug,
      externalId: slug,
      fields: {
        slug,
        name: str(role.name),
        description: str(role.description),
        type: str(role.type),
        permissions: (role.permissions ?? []).join(", "),
        createdAt,
      },
      resolvedOutputs: { roleSlug: slug },
      secretStates: [],
      createdAt,
      updatedAt: str(role.updated_at) || createdAt,
    };
  }

  private mapWebhookEndpoint(accountId: string, endpoint: WosWebhookEndpoint): ResourceInstance {
    const id = str(endpoint.id);
    const createdAt = str(endpoint.created_at) || new Date().toISOString();
    const url = str(endpoint.endpoint_url);
    let host = url;
    try {
      host = new URL(url).host;
    } catch {
      // Keep the raw URL when it doesn't parse.
    }

    return {
      id: `${accountId}:webhook-endpoint:${id}`,
      pluginId: "workos",
      resourceTypeId: "webhook-endpoint",
      accountId,
      displayName: host || id,
      externalId: id,
      fields: {
        endpointUrl: url,
        status: str(endpoint.status),
        events: (endpoint.events ?? []).join(", "),
        createdAt,
      },
      resolvedOutputs: {
        webhookEndpointId: id,
        signingSecret: str(endpoint.secret),
      },
      secretStates: [],
      createdAt,
      updatedAt: str(endpoint.updated_at) || createdAt,
    };
  }

  // -------------------------------------------------------------------------
  // Dashboard stats
  // -------------------------------------------------------------------------

  async fetchDashboardStats(
    resourceTypeId: string,
    resourceId: string,
    _accountId: string,
  ): Promise<DashboardStat[]> {
    const id = externalIdOf(resourceId);

    if (resourceTypeId === "organization") {
      const [memberships, invitations, connections, directories] = await Promise.all([
        this.paginate<WosMembership>("/user_management/organization_memberships", {
          organization_id: id,
        }).catch(() => [] as WosMembership[]),
        this.paginate<WosInvitation>("/user_management/invitations", {
          organization_id: id,
        }).catch(() => [] as WosInvitation[]),
        this.paginate<WosConnection>("/connections", { organization_id: id }).catch(
          () => [] as WosConnection[],
        ),
        this.paginate<WosDirectory>("/directories", { organization_id: id }).catch(
          () => [] as WosDirectory[],
        ),
      ]);
      const pending = invitations.filter((invitation) => invitation.state === "pending").length;
      return [
        { label: "Members", value: String(memberships.length) },
        { label: "Pending Invites", value: String(pending) },
        { label: "SSO Connections", value: String(connections.length) },
        { label: "Directories", value: String(directories.length) },
      ];
    }

    if (resourceTypeId === "directory") {
      const [users, groups] = await Promise.all([
        this.paginate<WosDirectoryUser>("/directory_users", { directory: id }).catch(
          () => [] as WosDirectoryUser[],
        ),
        this.paginate<WosDirectoryGroup>("/directory_groups", { directory: id }).catch(
          () => [] as WosDirectoryGroup[],
        ),
      ]);
      return [
        { label: "Synced Users", value: String(users.length) },
        { label: "Synced Groups", value: String(groups.length) },
      ];
    }

    return [];
  }

  // -------------------------------------------------------------------------
  // Create
  // -------------------------------------------------------------------------

  async getCreateConfig(typeId: string, parentResourceId?: string): Promise<CreateResourceConfig> {
    switch (typeId) {
      case "organization":
        return {
          fields: [
            { key: "name", label: "Name", kind: "text", required: true },
            {
              key: "domains",
              label: "Domains",
              kind: "string-list",
              required: false,
              addLabel: "+ Add domain",
              description:
                "Optional organization domains. Added in pending state — verify them in the WorkOS dashboard.",
            },
          ],
        };
      case "user":
        return {
          fields: [
            { key: "email", label: "Email", kind: "text", required: true },
            { key: "firstName", label: "First Name", kind: "text", required: false },
            { key: "lastName", label: "Last Name", kind: "text", required: false },
            {
              key: "password",
              label: "Password",
              kind: "password",
              required: false,
              description:
                "Optional. Leave blank for users who will sign in through SSO, Magic Auth, or a password they set themselves.",
            },
            {
              key: "emailVerified",
              label: "Email Verified",
              kind: "select",
              required: false,
              options: [
                { id: "false", label: "No — WorkOS verifies on first sign-in" },
                { id: "true", label: "Yes — mark as already verified" },
              ],
              defaultValue: "false",
            },
          ],
        };
      case "organization-membership": {
        const fields: CreateFieldConfig[] = [
          ...(await this.organizationPickerField(parentResourceId)),
          {
            key: "userId",
            label: "User",
            kind: "resource-picker",
            required: true,
            description: "The user to add to the organization.",
            associationSources: [
              { pluginId: "workos", resourceTypeId: "user", outputKey: "userId" },
            ],
          },
          await this.rolePickerField(parentResourceId),
        ];
        return { fields };
      }
      case "invitation": {
        const fields: CreateFieldConfig[] = [
          ...(await this.organizationPickerField(parentResourceId)),
          { key: "email", label: "Email", kind: "text", required: true },
          await this.rolePickerField(parentResourceId),
          {
            key: "expiresInDays",
            label: "Expires In (days)",
            kind: "number",
            required: false,
            minValue: 1,
            maxValue: 30,
            defaultValue: "7",
            description: "WorkOS allows 1–30 days. Defaults to 7.",
          },
        ];
        return { fields };
      }
      case "role":
        return {
          fields: [
            {
              key: "slug",
              label: "Slug",
              kind: "text",
              required: true,
              placeholder: "editor",
              description: "Unique identifier used in role assignments. Max 48 characters.",
            },
            { key: "name", label: "Name", kind: "text", required: true, placeholder: "Editor" },
            {
              key: "description",
              label: "Description",
              kind: "text",
              required: false,
              description: "Optional, max 150 characters.",
            },
          ],
        };
      case "webhook-endpoint":
        return {
          fields: [
            {
              key: "endpointUrl",
              label: "Endpoint URL",
              kind: "text",
              required: true,
              placeholder: "https://example.com/webhooks",
              description: "HTTPS URL WorkOS delivers events to.",
            },
            {
              key: "events",
              label: "Events",
              kind: "string-list",
              required: true,
              addLabel: "+ Add event",
              description:
                "Event types to subscribe to, e.g. user.created, invitation.accepted, dsync.user.updated, connection.activated. Full list: workos.com/docs/events.",
            },
          ],
        };
      default:
        throw new Error(`WorkOS plugin: cannot create resource type "${typeId}"`);
    }
  }

  /**
   * An organization picker, unless the create was launched from an
   * organization's detail page — the parent already answers the question.
   */
  private async organizationPickerField(parentResourceId?: string): Promise<CreateFieldConfig[]> {
    if (parentResourceId) return [];
    const orgs = await this.fetchOrganizations().catch(() => [] as WosOrganization[]);
    const options = orgs
      .filter((org) => org.id)
      .map((org) => ({ id: str(org.id), label: str(org.name) || str(org.id) }));
    return [
      {
        key: "organizationId",
        label: "Organization",
        kind: "select",
        required: true,
        options,
        ...(options[0] ? { defaultValue: options[0].id } : {}),
      },
    ];
  }

  /**
   * A role picker fed from the live role list — org-scoped roles when the
   * parent organization is known, environment roles otherwise — so the user
   * picks a name instead of typing a slug.
   */
  private async rolePickerField(parentResourceId?: string): Promise<CreateFieldConfig> {
    const path = parentResourceId
      ? `/authorization/organizations/${encodeURIComponent(externalIdOf(parentResourceId))}/roles`
      : "/authorization/roles";
    const roles = await this.fetch<WosList<WosRole>>(path)
      .then((body) => body.data ?? [])
      .catch(() => [] as WosRole[]);
    const options = roles
      .filter((role) => role.slug)
      .map((role) => ({ id: str(role.slug), label: str(role.name) || str(role.slug) }));
    if (options.length === 0) {
      return {
        key: "roleSlug",
        label: "Role",
        kind: "text",
        required: false,
        description: "Optional role slug. Leave blank for the organization's default role.",
      };
    }
    return {
      key: "roleSlug",
      label: "Role",
      kind: "select",
      required: false,
      options,
      description: "Leave unset for the organization's default role.",
    };
  }

  private resolveOrganizationId(fields: Record<string, string>, parentResourceId?: string): string {
    const organizationId = parentResourceId
      ? externalIdOf(parentResourceId)
      : fields["organizationId"];
    if (!organizationId) throw new Error("WorkOS plugin: an organization is required");
    return organizationId;
  }

  async createResource(
    typeId: string,
    accountId: string,
    fields: Record<string, string>,
    parentResourceId?: string,
  ): Promise<ResourceInstance> {
    switch (typeId) {
      case "organization": {
        // POST /organizations — domain_data entries need an explicit state;
        // "pending" defers verification to the dashboard.
        const domains = (fields["domains"] ?? "")
          .split(",")
          .map((domain) => domain.trim())
          .filter(Boolean);
        const org = await this.fetch<WosOrganization>("/organizations", {
          method: "POST",
          body: JSON.stringify({
            name: fields["name"],
            ...(domains.length > 0
              ? { domain_data: domains.map((domain) => ({ domain, state: "pending" })) }
              : {}),
          }),
        });
        return this.mapOrganization(accountId, org);
      }
      case "user": {
        const user = await this.fetch<WosUser>("/user_management/users", {
          method: "POST",
          body: JSON.stringify({
            email: fields["email"],
            ...(fields["firstName"] ? { first_name: fields["firstName"] } : {}),
            ...(fields["lastName"] ? { last_name: fields["lastName"] } : {}),
            ...(fields["password"] ? { password: fields["password"] } : {}),
            ...(fields["emailVerified"] === "true" ? { email_verified: true } : {}),
          }),
        });
        return this.mapUser(accountId, user);
      }
      case "organization-membership": {
        const organizationId = this.resolveOrganizationId(fields, parentResourceId);
        const userId = fields["userId"];
        if (!userId) throw new Error("WorkOS plugin: a user is required");
        const membership = await this.fetch<WosMembership>(
          "/user_management/organization_memberships",
          {
            method: "POST",
            body: JSON.stringify({
              user_id: userId,
              organization_id: organizationId,
              ...(fields["roleSlug"] ? { role_slug: fields["roleSlug"] } : {}),
            }),
          },
        );
        const email = await this.fetchUserEmail(userId);
        return this.mapMembership(accountId, membership, email);
      }
      case "invitation": {
        const organizationId = this.resolveOrganizationId(fields, parentResourceId);
        const invitation = await this.fetch<WosInvitation>("/user_management/invitations", {
          method: "POST",
          body: JSON.stringify({
            email: fields["email"],
            organization_id: organizationId,
            ...(fields["roleSlug"] ? { role_slug: fields["roleSlug"] } : {}),
            ...(fields["expiresInDays"]
              ? { expires_in_days: Number(fields["expiresInDays"]) }
              : {}),
          }),
        });
        return this.mapInvitation(accountId, invitation);
      }
      case "role": {
        const role = await this.fetch<WosRole>("/authorization/roles", {
          method: "POST",
          body: JSON.stringify({
            slug: fields["slug"],
            name: fields["name"],
            ...(fields["description"] ? { description: fields["description"] } : {}),
          }),
        });
        return this.mapRole(accountId, role);
      }
      case "webhook-endpoint": {
        const events = (fields["events"] ?? "")
          .split(",")
          .map((event) => event.trim())
          .filter(Boolean);
        if (events.length === 0) {
          throw new Error("WorkOS plugin: at least one event type is required");
        }
        const endpoint = await this.fetch<WosWebhookEndpoint>("/webhook_endpoints", {
          method: "POST",
          body: JSON.stringify({ endpoint_url: fields["endpointUrl"], events }),
        });
        return this.mapWebhookEndpoint(accountId, endpoint);
      }
      default:
        throw new Error(`WorkOS plugin: cannot create resource type "${typeId}"`);
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
    const id = externalIdOf(resourceId);
    switch (typeId) {
      case "organization": {
        const org = await this.fetch<WosOrganization>(`/organizations/${encodeURIComponent(id)}`, {
          method: "PUT",
          body: JSON.stringify({ ...(fields["name"] ? { name: fields["name"] } : {}) }),
        });
        return this.mapOrganization(accountId, org);
      }
      case "user": {
        const body: Record<string, unknown> = {};
        if (fields["firstName"] !== undefined) body["first_name"] = fields["firstName"];
        if (fields["lastName"] !== undefined) body["last_name"] = fields["lastName"];
        if (fields["emailVerified"] !== undefined) {
          body["email_verified"] = fields["emailVerified"] === "true";
        }
        const user = await this.fetch<WosUser>(`/user_management/users/${encodeURIComponent(id)}`, {
          method: "PUT",
          body: JSON.stringify(body),
        });
        return this.mapUser(accountId, user);
      }
      case "organization-membership": {
        const membership = await this.fetch<WosMembership>(
          `/user_management/organization_memberships/${encodeURIComponent(id)}`,
          { method: "PUT", body: JSON.stringify({ role_slug: fields["role"] }) },
        );
        const email = await this.fetchUserEmail(str(membership.user_id));
        return this.mapMembership(accountId, membership, email);
      }
      case "role": {
        const role = await this.fetch<WosRole>(`/authorization/roles/${encodeURIComponent(id)}`, {
          method: "PATCH",
          body: JSON.stringify({
            ...(fields["name"] !== undefined ? { name: fields["name"] } : {}),
            ...(fields["description"] !== undefined ? { description: fields["description"] } : {}),
          }),
        });
        return this.mapRole(accountId, role);
      }
      case "webhook-endpoint": {
        const body: Record<string, unknown> = {};
        if (fields["endpointUrl"] !== undefined) body["endpoint_url"] = fields["endpointUrl"];
        if (fields["status"] !== undefined) body["status"] = fields["status"];
        const endpoint = await this.fetch<WosWebhookEndpoint>(
          `/webhook_endpoints/${encodeURIComponent(id)}`,
          { method: "PATCH", body: JSON.stringify(body) },
        );
        return this.mapWebhookEndpoint(accountId, endpoint);
      }
      default:
        throw new Error(`WorkOS plugin: cannot update resource type "${typeId}"`);
    }
  }

  // -------------------------------------------------------------------------
  // Delete + actions
  // -------------------------------------------------------------------------

  async deleteResource(typeId: string, resourceId: string, _accountId: string): Promise<void> {
    const id = encodeURIComponent(externalIdOf(resourceId));
    switch (typeId) {
      case "organization":
        return this.requestVoid(`/organizations/${id}`, "DELETE");
      case "user":
        return this.requestVoid(`/user_management/users/${id}`, "DELETE");
      case "organization-membership":
        return this.requestVoid(`/user_management/organization_memberships/${id}`, "DELETE");
      case "invitation":
        // Invitations have no DELETE — revoking is the removal operation.
        await this.fetch<WosInvitation>(`/user_management/invitations/${id}/revoke`, {
          method: "POST",
        });
        return;
      case "connection":
        return this.requestVoid(`/connections/${id}`, "DELETE");
      case "directory":
        return this.requestVoid(`/directories/${id}`, "DELETE");
      case "webhook-endpoint":
        return this.requestVoid(`/webhook_endpoints/${id}`, "DELETE");
      default:
        throw new Error(`WorkOS plugin: cannot delete resource type "${typeId}"`);
    }
  }

  async invokeAction(
    typeId: string,
    resourceId: string,
    actionId: string,
    _accountId: string,
  ): Promise<void> {
    const id = encodeURIComponent(externalIdOf(resourceId));

    if (typeId === "organization-membership") {
      if (actionId === "deactivate") {
        await this.fetch<WosMembership>(
          `/user_management/organization_memberships/${id}/deactivate`,
          { method: "PUT" },
        );
        return;
      }
      if (actionId === "reactivate") {
        await this.fetch<WosMembership>(
          `/user_management/organization_memberships/${id}/reactivate`,
          { method: "PUT" },
        );
        return;
      }
    }

    if (typeId === "invitation") {
      if (actionId === "resend") {
        await this.fetch<WosInvitation>(`/user_management/invitations/${id}/resend`, {
          method: "POST",
        });
        return;
      }
      if (actionId === "revoke") {
        await this.fetch<WosInvitation>(`/user_management/invitations/${id}/revoke`, {
          method: "POST",
        });
        return;
      }
    }

    throw new Error(`WorkOS plugin: unknown action "${actionId}" for type "${typeId}"`);
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  renderDetail(resource: ResourceInstance): DetailViewSchema {
    switch (resource.resourceTypeId) {
      case "organization":
        return this.renderOrganizationDetail(resource);
      case "user":
        return this.renderUserDetail(resource);
      case "organization-membership":
        return this.renderMembershipDetail(resource);
      case "invitation":
        return this.renderInvitationDetail(resource);
      case "connection":
        return this.renderConnectionDetail(resource);
      case "directory":
        return this.renderDirectoryDetail(resource);
      case "directory-user":
        return this.renderDirectoryUserDetail(resource);
      case "directory-group":
        return this.renderDirectoryGroupDetail(resource);
      case "role":
        return this.renderRoleDetail(resource);
      case "webhook-endpoint":
        return this.renderWebhookEndpointDetail(resource);
      default:
        return {
          title: resource.displayName,
          subtitle: resource.resourceTypeId,
          status: { kind: "status-dot", status: "info" },
          sections: [
            {
              kind: "section",
              title: "Resource",
              children: [{ kind: "text", content: resource.resourceTypeId }],
            },
          ],
          headerActions: [],
        };
    }
  }

  renderSidebarItem(resource: ResourceInstance): SidebarItemSchema {
    const fields = resource.fields;
    let status: ResourceStatus = "info";
    switch (resource.resourceTypeId) {
      case "organization":
        status = "healthy";
        break;
      case "user":
        status = fields["emailVerified"] === true ? "healthy" : "degraded";
        break;
      case "organization-membership":
        status = membershipStatusDot(String(fields["status"] ?? ""));
        break;
      case "invitation":
        status = invitationStateDot(String(fields["state"] ?? ""));
        break;
      case "connection":
        status = connectionStateDot(String(fields["state"] ?? ""));
        break;
      case "directory":
        status = directoryStateDot(String(fields["state"] ?? ""));
        break;
      case "webhook-endpoint":
        status = fields["status"] === "enabled" ? "healthy" : "degraded";
        break;
      default:
        status = "info";
    }
    return {
      id: resource.id,
      label: resource.displayName,
      status: { kind: "status-dot", status },
    };
  }

  private renderOrganizationDetail(resource: ResourceInstance): DetailViewSchema {
    const fields = resource.fields;
    let domains: WosOrganizationDomain[] = [];
    try {
      domains = JSON.parse(String(resource.resolvedOutputs["__domains__"] ?? "[]"));
    } catch {
      domains = [];
    }

    const sections: DetailViewSchema["sections"] = [
      {
        kind: "section",
        title: "Organization",
        children: [
          {
            kind: "key-value-list",
            items: [
              {
                key: "Organization ID",
                value: String(fields["organizationId"] ?? ""),
                copyable: true,
              },
              { key: "Name", value: String(fields["name"] ?? "") },
              { key: "External ID", value: String(fields["externalId"] ?? "") || "—" },
              { key: "Created", value: String(fields["createdAt"] ?? "") || "—" },
            ],
          },
        ],
      },
    ];

    if (domains.length > 0) {
      sections.push({
        kind: "section",
        title: "Domains",
        children: [
          {
            kind: "table",
            columns: [
              { key: "domain", label: "Domain", mono: true },
              { key: "state", label: "State", width: "narrow" },
            ],
            rows: domains.map((domain) => ({
              cells: { domain: str(domain.domain), state: str(domain.state) || "—" },
            })),
          },
        ],
      });
    }

    return {
      title: resource.displayName,
      subtitle: "WorkOS organization",
      status: { kind: "status-dot", status: "healthy" },
      sections,
      headerActions: [
        { kind: "action", label: "Refresh", action: { type: "refresh-resource" } },
        {
          kind: "action",
          label: "Open Dashboard",
          action: { type: "open-url", url: "https://dashboard.workos.com/" },
        },
      ],
    };
  }

  private renderUserDetail(resource: ResourceInstance): DetailViewSchema {
    const fields = resource.fields;
    const verified = fields["emailVerified"] === true;

    return {
      title: resource.displayName,
      subtitle: "WorkOS user",
      status: {
        kind: "status-dot",
        status: verified ? "healthy" : "degraded",
        label: verified ? "Verified" : "Unverified",
      },
      sections: [
        {
          kind: "section",
          title: "User",
          children: [
            {
              kind: "key-value-list",
              items: [
                { key: "User ID", value: String(fields["userId"] ?? ""), copyable: true },
                { key: "Email", value: String(fields["email"] ?? ""), copyable: true },
                {
                  key: "Name",
                  value:
                    [String(fields["firstName"] ?? ""), String(fields["lastName"] ?? "")]
                      .filter(Boolean)
                      .join(" ") || "—",
                },
                { key: "Email Verified", value: verified ? "Yes" : "No" },
                { key: "External ID", value: String(fields["externalId"] ?? "") || "—" },
                { key: "Last Sign-In", value: String(fields["lastSignInAt"] ?? "") || "Never" },
                { key: "Created", value: String(fields["createdAt"] ?? "") || "—" },
              ],
            },
          ],
        },
      ],
      headerActions: [{ kind: "action", label: "Refresh", action: { type: "refresh-resource" } }],
    };
  }

  private renderMembershipDetail(resource: ResourceInstance): DetailViewSchema {
    const fields = resource.fields;
    const status = String(fields["status"] ?? "");
    const directoryManaged = fields["directoryManaged"] === true;

    const headerActions: DetailViewSchema["headerActions"] = [
      { kind: "action", label: "Refresh", action: { type: "refresh-resource" } },
    ];
    // Directory-managed memberships belong to Directory Sync — manual
    // deactivation would just be overwritten on the next sync.
    if (!directoryManaged && status === "active") {
      headerActions.push({
        kind: "action",
        label: "Deactivate",
        variant: "danger",
        action: {
          type: "plugin-action",
          actionId: "deactivate",
          confirmMessage:
            "Deactivate this membership? The user loses access to the organization but keeps their role assignments for reactivation.",
          successMessage: "Membership deactivated.",
        },
      });
    }
    if (!directoryManaged && status === "inactive") {
      headerActions.push({
        kind: "action",
        label: "Reactivate",
        action: {
          type: "plugin-action",
          actionId: "reactivate",
          successMessage: "Membership reactivated.",
        },
      });
    }

    return {
      title: resource.displayName,
      subtitle: `Membership · ${status || "unknown"}`,
      status: { kind: "status-dot", status: membershipStatusDot(status) },
      sections: [
        {
          kind: "section",
          title: "Membership",
          children: [
            {
              kind: "key-value-list",
              items: [
                { key: "User", value: String(fields["userEmail"] ?? "") || "—" },
                { key: "User ID", value: String(fields["userId"] ?? ""), copyable: true },
                {
                  key: "Organization ID",
                  value: String(fields["organizationId"] ?? ""),
                  copyable: true,
                },
                { key: "Role", value: String(fields["role"] ?? "") || "—" },
                { key: "Status", value: status || "—" },
                { key: "Directory Managed", value: directoryManaged ? "Yes" : "No" },
                { key: "Created", value: String(fields["createdAt"] ?? "") || "—" },
              ],
            },
            ...(directoryManaged
              ? [
                  {
                    kind: "text" as const,
                    content:
                      "This membership is managed by Directory Sync — changes made here would be overwritten by the directory provider.",
                    variant: "muted" as const,
                  },
                ]
              : []),
          ],
        },
      ],
      headerActions,
    };
  }

  private renderInvitationDetail(resource: ResourceInstance): DetailViewSchema {
    const fields = resource.fields;
    const state = String(fields["state"] ?? "");

    const headerActions: DetailViewSchema["headerActions"] = [
      { kind: "action", label: "Refresh", action: { type: "refresh-resource" } },
    ];
    if (state === "pending") {
      headerActions.push(
        {
          kind: "action",
          label: "Resend",
          action: {
            type: "plugin-action",
            actionId: "resend",
            successMessage: "Invitation email resent.",
          },
        },
        {
          kind: "action",
          label: "Revoke",
          variant: "danger",
          action: {
            type: "plugin-action",
            actionId: "revoke",
            confirmMessage: "Revoke this invitation? The accept link stops working immediately.",
            successMessage: "Invitation revoked.",
          },
        },
      );
    }

    return {
      title: resource.displayName,
      subtitle: `Invitation · ${state || "unknown"}`,
      status: { kind: "status-dot", status: invitationStateDot(state) },
      sections: [
        {
          kind: "section",
          title: "Invitation",
          children: [
            {
              kind: "key-value-list",
              items: [
                { key: "Email", value: String(fields["email"] ?? ""), copyable: true },
                { key: "State", value: state || "—" },
                { key: "Role", value: String(fields["roleSlug"] ?? "") || "Default" },
                {
                  key: "Organization ID",
                  value: String(fields["organizationId"] ?? "") || "—",
                },
                { key: "Expires", value: String(fields["expiresAt"] ?? "") || "—" },
                { key: "Accepted", value: String(fields["acceptedAt"] ?? "") || "—" },
                { key: "Revoked", value: String(fields["revokedAt"] ?? "") || "—" },
                { key: "Created", value: String(fields["createdAt"] ?? "") || "—" },
              ],
            },
          ],
        },
      ],
      headerActions,
    };
  }

  private renderConnectionDetail(resource: ResourceInstance): DetailViewSchema {
    const fields = resource.fields;
    const state = String(fields["state"] ?? "");

    return {
      title: resource.displayName,
      subtitle: `SSO connection · ${String(fields["connectionType"] ?? "")}`,
      status: { kind: "status-dot", status: connectionStateDot(state) },
      sections: [
        {
          kind: "section",
          title: "Connection",
          children: [
            {
              kind: "key-value-list",
              items: [
                {
                  key: "Connection ID",
                  value: String(resource.externalId ?? ""),
                  copyable: true,
                },
                { key: "Type", value: String(fields["connectionType"] ?? "") || "—" },
                { key: "State", value: state || "—" },
                { key: "Domains", value: String(fields["domains"] ?? "") || "—" },
                {
                  key: "Organization ID",
                  value: String(fields["organizationId"] ?? ""),
                  copyable: true,
                },
                { key: "Created", value: String(fields["createdAt"] ?? "") || "—" },
              ],
            },
            {
              kind: "text",
              content:
                "Connections are configured through the WorkOS dashboard or an Admin Portal session — the API only lists, inspects and deletes them.",
              variant: "muted",
            },
          ],
        },
      ],
      headerActions: [
        { kind: "action", label: "Refresh", action: { type: "refresh-resource" } },
        {
          kind: "action",
          label: "Open Dashboard",
          action: { type: "open-url", url: "https://dashboard.workos.com/" },
        },
      ],
    };
  }

  private renderDirectoryDetail(resource: ResourceInstance): DetailViewSchema {
    const fields = resource.fields;
    const state = String(fields["state"] ?? "");

    return {
      title: resource.displayName,
      subtitle: `Directory · ${String(fields["type"] ?? "")}`,
      status: { kind: "status-dot", status: directoryStateDot(state) },
      sections: [
        {
          kind: "section",
          title: "Directory",
          children: [
            {
              kind: "key-value-list",
              items: [
                { key: "Directory ID", value: String(resource.externalId ?? ""), copyable: true },
                { key: "Provider", value: String(fields["type"] ?? "") || "—" },
                { key: "State", value: state || "—" },
                {
                  key: "Organization ID",
                  value: String(fields["organizationId"] ?? ""),
                  copyable: true,
                },
                { key: "External Key", value: String(fields["externalKey"] ?? "") || "—" },
                { key: "Created", value: String(fields["createdAt"] ?? "") || "—" },
              ],
            },
            ...(state === "invalid_credentials"
              ? [
                  {
                    kind: "text" as const,
                    content:
                      "The directory provider is rejecting WorkOS's credentials — reconnect it from the dashboard or an Admin Portal session.",
                  },
                ]
              : []),
          ],
        },
      ],
      headerActions: [
        { kind: "action", label: "Refresh", action: { type: "refresh-resource" } },
        {
          kind: "action",
          label: "Open Dashboard",
          action: { type: "open-url", url: "https://dashboard.workos.com/" },
        },
      ],
    };
  }

  private renderDirectoryUserDetail(resource: ResourceInstance): DetailViewSchema {
    const fields = resource.fields;
    return {
      title: resource.displayName,
      subtitle: "Directory user",
      status: { kind: "status-dot", status: "info" },
      sections: [
        {
          kind: "section",
          title: "Directory User",
          children: [
            {
              kind: "key-value-list",
              items: [
                { key: "ID", value: String(resource.externalId ?? ""), copyable: true },
                { key: "Email", value: String(fields["email"] ?? "") || "—" },
                {
                  key: "Name",
                  value:
                    [String(fields["firstName"] ?? ""), String(fields["lastName"] ?? "")]
                      .filter(Boolean)
                      .join(" ") || "—",
                },
                { key: "IdP ID", value: String(fields["idpId"] ?? "") || "—" },
                { key: "Directory ID", value: String(fields["directoryId"] ?? ""), copyable: true },
                { key: "Created", value: String(fields["createdAt"] ?? "") || "—" },
              ],
            },
            {
              kind: "text",
              content: "Read-only — the identity provider owns this record; WorkOS mirrors it.",
              variant: "muted",
            },
          ],
        },
      ],
      headerActions: [{ kind: "action", label: "Refresh", action: { type: "refresh-resource" } }],
    };
  }

  private renderDirectoryGroupDetail(resource: ResourceInstance): DetailViewSchema {
    const fields = resource.fields;
    return {
      title: resource.displayName,
      subtitle: "Directory group",
      status: { kind: "status-dot", status: "info" },
      sections: [
        {
          kind: "section",
          title: "Directory Group",
          children: [
            {
              kind: "key-value-list",
              items: [
                { key: "ID", value: String(resource.externalId ?? ""), copyable: true },
                { key: "Name", value: String(fields["name"] ?? "") || "—" },
                { key: "IdP ID", value: String(fields["idpId"] ?? "") || "—" },
                { key: "Directory ID", value: String(fields["directoryId"] ?? ""), copyable: true },
                { key: "Created", value: String(fields["createdAt"] ?? "") || "—" },
              ],
            },
            {
              kind: "text",
              content: "Read-only — the identity provider owns this group; WorkOS mirrors it.",
              variant: "muted",
            },
          ],
        },
      ],
      headerActions: [{ kind: "action", label: "Refresh", action: { type: "refresh-resource" } }],
    };
  }

  private renderRoleDetail(resource: ResourceInstance): DetailViewSchema {
    const fields = resource.fields;
    const permissions = String(fields["permissions"] ?? "")
      .split(",")
      .map((permission) => permission.trim())
      .filter(Boolean);

    const sections: DetailViewSchema["sections"] = [
      {
        kind: "section",
        title: "Role",
        children: [
          {
            kind: "key-value-list",
            items: [
              { key: "Slug", value: String(fields["slug"] ?? ""), copyable: true },
              { key: "Name", value: String(fields["name"] ?? "") || "—" },
              { key: "Description", value: String(fields["description"] ?? "") || "—" },
              { key: "Scope", value: String(fields["type"] ?? "") || "—" },
              { key: "Created", value: String(fields["createdAt"] ?? "") || "—" },
            ],
          },
        ],
      },
    ];

    if (permissions.length > 0) {
      sections.push({
        kind: "section",
        title: "Permissions",
        children: [
          {
            kind: "table",
            columns: [{ key: "permission", label: "Permission", mono: true }],
            rows: permissions.map((permission) => ({ cells: { permission } })),
          },
        ],
      });
    }

    return {
      title: resource.displayName,
      subtitle: "WorkOS role",
      status: { kind: "status-dot", status: "info" },
      sections,
      headerActions: [{ kind: "action", label: "Refresh", action: { type: "refresh-resource" } }],
    };
  }

  private renderWebhookEndpointDetail(resource: ResourceInstance): DetailViewSchema {
    const fields = resource.fields;
    const status = String(fields["status"] ?? "");
    const events = String(fields["events"] ?? "")
      .split(",")
      .map((event) => event.trim())
      .filter(Boolean);

    const sections: DetailViewSchema["sections"] = [
      {
        kind: "section",
        title: "Endpoint",
        children: [
          {
            kind: "key-value-list",
            items: [
              { key: "ID", value: String(resource.externalId ?? ""), copyable: true },
              { key: "URL", value: String(fields["endpointUrl"] ?? ""), copyable: true },
              { key: "Status", value: status || "—" },
              { key: "Created", value: String(fields["createdAt"] ?? "") || "—" },
            ],
          },
          {
            kind: "text",
            content:
              "The signing secret is available as the sensitive `signingSecret` output — use it to verify webhook payload signatures.",
            variant: "muted",
          },
        ],
      },
    ];

    if (events.length > 0) {
      sections.push({
        kind: "section",
        title: `Subscribed Events (${events.length})`,
        children: [
          {
            kind: "table",
            columns: [{ key: "event", label: "Event", mono: true }],
            rows: events.map((event) => ({ cells: { event } })),
          },
        ],
      });
    }

    return {
      title: resource.displayName,
      subtitle: `Webhook endpoint · ${status || "unknown"}`,
      status: {
        kind: "status-dot",
        status: status === "enabled" ? "healthy" : "degraded",
      },
      sections,
      headerActions: [{ kind: "action", label: "Refresh", action: { type: "refresh-resource" } }],
    };
  }
}
