import type { Credentials } from "./plugin.js";
import { attempt, runPluginEffect } from "@infrawrench/plugin-base/effect";
import type { PluginEffect } from "@infrawrench/plugin-base";
import type {
  CreateFieldConfig,
  CreateResourceConfig,
  DashboardStat,
  DetailViewSchema,
  HostServices,
  MetricSeries,
  PluginClient,
  ResourceInstance,
  ResourceStatus,
  SidebarItemSchema,
} from "@infrawrench/plugin-base";
import {
  commaSeparated,
  externalIdOf,
  joinSubtitle,
  pathEncode,
  requireListPage,
  rethrowIncompleteList,
} from "@infrawrench/plugin-base";
import type {
  ApiBody,
  CredentialExport,
  LogsFetchParams,
  LogsFetchResult,
  PolicyOption,
} from "@infrawrench/plugin-base";
import type { operations } from "./api-types.gen.js";
import {
  createWorkosApi,
  isOutOfReach,
  PICKER_READ,
  type ListRead,
  type WosApiKey,
  type WosConnection,
  type WosDirectory,
  type WosDirectoryGroup,
  type WosDirectoryUser,
  type WosFeatureFlag,
  type WosGroup,
  type WosInvitation,
  type WosMemberRow,
  type WosMembership,
  type WosMembershipStatus,
  type WosOrganization,
  type WosOrganizationDomain,
  type WosPermission,
  type WosRole,
  type WosSession,
  type WosUser,
  type WosWebhookEndpoint,
} from "./api.js";
import { readEventTail, readEventWindow } from "./event-reads.js";
import { ORGANIZATION_LOG_EVENTS, ORGANIZATION_METRIC_SERIES, WEBHOOK_EVENTS } from "./events.js";

/** The Metrics tab's default window when the host passes no range. */
const METRICS_DEFAULT_RANGE_MS = 24 * 60 * 60 * 1000;

/** The Events API answers at most 30 days of events per request. */
const EVENTS_MAX_RANGE_MS = 30 * 24 * 60 * 60 * 1000;

/** Roughly how many points each metric series is bucketed into. */
const METRIC_BUCKETS = 48;

/** WorkOS lists only active memberships unless asked for the others. */
const ALL_MEMBERSHIP_STATUSES = ["active", "inactive", "pending"] as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function str(value: string | null | undefined): string {
  return typeof value === "string" ? value : "";
}

/** For a read shown to a person, where a failure can show as none but part of a list cannot. */
function noneUnlessIncomplete(err: unknown): never[] {
  rethrowIncompleteList(err);
  return [];
}

/**
 * Run `load` once per parent. A parent the key cannot read holds nothing it can see, and
 * must not empty the whole listing. Any other failure says nothing about what the parent
 * holds, and reading it as none would prune its rows, so it fails the listing.
 */
async function loadPerParent<T>(
  kind: string,
  ids: string[],
  load: (id: string) => Promise<T[]>,
): Promise<T[]> {
  const settled = await Promise.allSettled(ids.map((id) => load(id)));
  return settled.flatMap((result, index) => {
    if (result.status === "fulfilled") return result.value;
    if (!isOutOfReach(result.reason)) throw result.reason;
    console.warn(`WorkOS plugin: skipping ${kind} ${ids[index]}: ${result.reason}`);
    return [];
  });
}

/** Parse a `policy-picker` value (a JSON array of ids), tolerating a comma list. */
function pickedList(value: string | undefined): string[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed.map(String).filter(Boolean);
  } catch {
    // Not JSON: fall through to the comma convention.
  }
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

/** A field of an event's `data`, whose shape the document leaves open by event type. */
function eventText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

const PORTAL_INTENTS = [
  "sso",
  "dsync",
  "domain_verification",
  "certificate_renewal",
  "audit_logs",
  "log_streams",
  "bring_your_own_key",
] as const;

function isPortalIntent(value: string): value is (typeof PORTAL_INTENTS)[number] {
  return PORTAL_INTENTS.some((intent) => intent === value);
}

/** Split a composite `{organizationId}/{id}` external id. */
function orgScoped(externalId: string): [string, string] {
  const slash = externalId.indexOf("/");
  if (slash < 0) throw new Error(`WorkOS plugin: expected "organization/id", got "${externalId}"`);
  return [externalId.slice(0, slash), externalId.slice(slash + 1)];
}

function domainStateDot(state: string): ResourceStatus {
  switch (state) {
    case "verified":
    case "legacy_verified":
      return "healthy";
    case "pending":
    case "unverified":
      return "provisioning";
    case "failed":
      return "error";
    default:
      return "info";
  }
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
  private readonly api: ReturnType<typeof createWorkosApi>["api"];
  private readonly bodiless: ReturnType<typeof createWorkosApi>["bodiless"];
  /**
   * Per-instance cache of the webhook endpoint listing. There is no single-item
   * GET on /webhook_endpoints/{id}, so `getResource` re-lists; without the
   * cache every `resolveOutput` for a signing secret repeats the full sweep.
   */
  private webhookEndpointsCache: WosWebhookEndpoint[] | null = null;

  constructor(credentials: Credentials, services?: HostServices) {
    const apiKey = credentials["apiKey"];
    if (!apiKey) throw new Error("WorkOS plugin: missing apiKey credential");
    const { api, bodiless } = createWorkosApi({
      apiKey,
      caCert: credentials["caCert"] ?? "",
      http: services?.http,
    });
    this.api = api;
    this.bodiless = bodiless;
  }

  private async fetchOrganizations(read: ListRead = {}): Promise<WosOrganization[]> {
    return this.api.getAll("/organizations", "data", read);
  }

  private async listForEachOrganization<T>(
    load: (organizationId: string) => Promise<T[]>,
  ): Promise<T[]> {
    const orgs = await this.fetchOrganizations();
    return loadPerParent("organization", orgs.map((org) => str(org.id)).filter(Boolean), load);
  }

  private async fetchUsers(read: ListRead = {}): Promise<WosUser[]> {
    return this.api.getAll("/user_management/users", "data", read);
  }

  /** Map user_id → email so memberships can be labelled readably. */
  private async fetchUserEmailMap(read: ListRead = {}): Promise<Map<string, string>> {
    const users = await this.fetchUsers(read).catch(noneUnlessIncomplete);
    const map = new Map<string, string>();
    for (const user of users) {
      if (user.id && user.email) map.set(user.id, user.email);
    }
    return map;
  }

  // -------------------------------------------------------------------------
  // Listing
  // -------------------------------------------------------------------------

  listResources(typeId: string, accountId: string): PluginEffect<ResourceInstance[]> {
    return attempt(async () => {
      switch (typeId) {
        case "organization": {
          const orgs = await this.fetchOrganizations();
          return orgs.map((org) => this.mapOrganization(accountId, org));
        }
        case "user": {
          const users = await this.fetchUsers();
          return users.map((user) => this.mapUser(accountId, user));
        }
        case "organization-membership": {
          // GET /user_management/organization_memberships requires user_id or
          // organization_id, so fan out per org. Emails come from one users
          // sweep rather than a lookup per membership.
          const emails = await this.fetchUserEmailMap();
          const memberships = await this.listForEachOrganization((orgId) =>
            this.fetchMemberships(orgId),
          );
          return memberships.map((m) =>
            this.mapMembership(accountId, m, emails.get(str(m.user_id))),
          );
        }
        case "invitation": {
          const invitations = await this.listForEachOrganization((orgId) =>
            this.fetchInvitations(orgId),
          );
          return invitations.map((invitation) => this.mapInvitation(accountId, invitation));
        }
        case "connection": {
          const connections = await this.api.getAll("/connections", "data");
          return connections.map((connection) => this.mapConnection(accountId, connection));
        }
        case "directory": {
          const directories = await this.fetchDirectories();
          return directories.map((directory) => this.mapDirectory(accountId, directory));
        }
        case "directory-user": {
          const users = await this.listForEachDirectory((directoryId) =>
            this.fetchDirectoryUsers(directoryId),
          );
          return users.map((user) => this.mapDirectoryUser(accountId, user));
        }
        case "directory-group": {
          const groups = await this.listForEachDirectory((directoryId) =>
            this.fetchDirectoryGroups(directoryId),
          );
          return groups.map((group) => this.mapDirectoryGroup(accountId, group));
        }
        case "role": {
          // GET /authorization/roles: plain {data} list, no pagination.
          const body = await this.api.get("/authorization/roles");
          return requireListPage(body.data, {
            vendor: "WorkOS",
            path: "/authorization/roles",
            key: "data",
          }).map((role) => this.mapRole(accountId, role));
        }
        case "webhook-endpoint": {
          const endpoints = await this.fetchWebhookEndpoints();
          this.webhookEndpointsCache = endpoints;
          return endpoints.map((endpoint) => this.mapWebhookEndpoint(accountId, endpoint));
        }
        case "organization-domain": {
          // There is no domain listing route: every organization carries its
          // full domain objects, ids included.
          const orgs = await this.fetchOrganizations();
          return orgs.flatMap((org) =>
            (org.domains ?? [])
              .filter((domain) => domain.id)
              .map((domain) =>
                this.mapOrganizationDomain(accountId, {
                  ...domain,
                  organization_id: domain.organization_id ?? str(org.id),
                }),
              ),
          );
        }
        case "organization-role": {
          const roles = await this.listForEachOrganization(async (orgId) => {
            const path = `/authorization/organizations/${pathEncode(orgId)}/roles` as const;
            const body = await this.api.get(path);
            // The org listing also returns the environment roles it inherits.
            return requireListPage(body.data, { vendor: "WorkOS", path, key: "data" })
              .filter((role) => role.type === "OrganizationRole")
              .map((role) => ({ role, orgId }));
          });
          return roles.map(({ role, orgId }) => this.mapOrganizationRole(accountId, orgId, role));
        }
        case "permission": {
          const permissions = await this.fetchPermissions();
          return permissions.map((permission) => this.mapPermission(accountId, permission));
        }
        case "organization-api-key": {
          const keys = await this.listForEachOrganization(async (orgId) =>
            (await this.fetchApiKeys(orgId)).map((key) => ({ key, orgId })),
          );
          return keys.map(({ key, orgId }) => this.mapApiKey(accountId, orgId, key));
        }
        case "feature-flag": {
          const flags = await this.api.getAll("/feature-flags", "data");
          return flags.map((flag) => this.mapFeatureFlag(accountId, flag));
        }
        case "group": {
          const groups = await this.listForEachOrganization((orgId) =>
            this.api.getAll(`/organizations/${pathEncode(orgId)}/groups`, "data"),
          );
          return groups.map((group) => this.mapGroup(accountId, group));
        }
        default:
          throw new Error(`WorkOS plugin: unknown resource type "${typeId}"`);
      }
    });
  }

  private async fetchDirectories(organizationId?: string): Promise<WosDirectory[]> {
    return this.api.getAll(
      "/directories",
      "data",
      organizationId === undefined ? {} : { query: { organization_id: organizationId } },
    );
  }

  private async fetchMemberships(
    organizationId: string,
    statuses: readonly WosMembershipStatus[] = ALL_MEMBERSHIP_STATUSES,
  ): Promise<WosMembership[]> {
    return this.api.getAll("/user_management/organization_memberships", "data", {
      query: { organization_id: organizationId, statuses: commaSeparated(statuses) },
    });
  }

  private async fetchInvitations(organizationId: string): Promise<WosInvitation[]> {
    return this.api.getAll("/user_management/invitations", "data", {
      query: { organization_id: organizationId },
    });
  }

  private async fetchDirectoryUsers(directory: string): Promise<WosDirectoryUser[]> {
    return this.api.getAll("/directory_users", "data", { query: { directory } });
  }

  private async fetchDirectoryGroups(directory: string): Promise<WosDirectoryGroup[]> {
    return this.api.getAll("/directory_groups", "data", { query: { directory } });
  }

  private async fetchWebhookEndpoints(): Promise<WosWebhookEndpoint[]> {
    return this.api.getAll("/webhook_endpoints", "data");
  }

  private async fetchPermissions(): Promise<WosPermission[]> {
    return this.api.getAll("/authorization/permissions", "data");
  }

  private async fetchApiKeys(organizationId: string): Promise<WosApiKey[]> {
    return this.api.getAll(`/organizations/${pathEncode(organizationId)}/api_keys`, "data");
  }

  private async fetchSessions(userId: string, read: ListRead = {}): Promise<WosSession[]> {
    return this.api.getAll(`/user_management/users/${pathEncode(userId)}/sessions`, "data", read);
  }

  private async listForEachDirectory<T>(load: (directoryId: string) => Promise<T[]>): Promise<T[]> {
    const directories = await this.fetchDirectories();
    return loadPerParent("directory", directories.map((d) => str(d.id)).filter(Boolean), load);
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
      switch (typeId) {
        case "organization": {
          const org = await this.api.get(`/organizations/${pathEncode(id)}`);
          return this.mapOrganization(accountId, org);
        }
        case "user": {
          const user = await this.api.get(`/user_management/users/${pathEncode(id)}`);
          return this.mapUser(accountId, user);
        }
        case "organization-membership": {
          const membership = await this.api.get(
            `/user_management/organization_memberships/${pathEncode(id)}`,
          );
          const email = await this.fetchUserEmail(str(membership.user_id));
          return this.mapMembership(accountId, membership, email);
        }
        case "invitation": {
          const invitation = await this.api.get(`/user_management/invitations/${pathEncode(id)}`);
          return this.mapInvitation(accountId, invitation);
        }
        case "connection": {
          const connection = await this.api.get(`/connections/${pathEncode(id)}`);
          return this.mapConnection(accountId, connection);
        }
        case "directory": {
          const directory = await this.api.get(`/directories/${pathEncode(id)}`);
          return this.mapDirectory(accountId, directory);
        }
        case "directory-user": {
          const user = await this.api.get(`/directory_users/${pathEncode(id)}`);
          return this.mapDirectoryUser(accountId, user);
        }
        case "directory-group": {
          const group = await this.api.get(`/directory_groups/${pathEncode(id)}`);
          return this.mapDirectoryGroup(accountId, group);
        }
        case "role": {
          const role = await this.api.get(`/authorization/roles/${pathEncode(id)}`);
          return this.mapRole(accountId, role);
        }
        case "webhook-endpoint": {
          // The spec documents PATCH/DELETE on /webhook_endpoints/{id} but no
          // GET, so re-list and pick the endpoint out. The list is cached per
          // client instance: resolveOutput funnels through here, and resolving
          // several signingSecret references must not repeat the full sweep.
          this.webhookEndpointsCache ??= await this.fetchWebhookEndpoints();
          const match = this.webhookEndpointsCache.find((endpoint) => endpoint.id === id);
          if (!match) throw new Error(`WorkOS plugin: webhook endpoint "${id}" not found`);
          return this.mapWebhookEndpoint(accountId, match);
        }
        case "organization-domain": {
          const domain = await this.api.get(`/organization_domains/${pathEncode(id)}`);
          return this.mapOrganizationDomain(accountId, domain);
        }
        case "organization-role": {
          const [orgId, slug] = orgScoped(id);
          const role = await this.api.get(
            `/authorization/organizations/${pathEncode(orgId)}/roles/${pathEncode(slug)}`,
          );
          return this.mapOrganizationRole(accountId, orgId, role);
        }
        case "permission": {
          const permission = await this.api.get(`/authorization/permissions/${pathEncode(id)}`);
          return this.mapPermission(accountId, permission);
        }
        case "organization-api-key": {
          // No single-key GET: list the owning organization's keys.
          const [orgId, keyId] = orgScoped(id);
          const keys = await this.fetchApiKeys(orgId);
          const match = keys.find((key) => key.id === keyId);
          if (!match) throw new Error(`WorkOS plugin: API key "${keyId}" not found`);
          return this.mapApiKey(accountId, orgId, match);
        }
        case "feature-flag": {
          const flag = await this.api.get(`/feature-flags/${pathEncode(id)}`);
          return this.mapFeatureFlag(accountId, flag);
        }
        case "group": {
          const [orgId, groupId] = orgScoped(id);
          const group = await this.api.get(
            `/organizations/${pathEncode(orgId)}/groups/${pathEncode(groupId)}`,
          );
          return this.mapGroup(accountId, group);
        }
        default:
          throw new Error(`WorkOS plugin: unknown resource type "${typeId}"`);
      }
    });
  }

  private async fetchUserEmail(userId: string): Promise<string | undefined> {
    if (!userId) return undefined;
    try {
      const user = await this.api.get(`/user_management/users/${pathEncode(userId)}`);
      return str(user.email) || undefined;
    } catch {
      return undefined;
    }
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
      throw new Error(`WorkOS plugin: cannot resolve output "${outputKey}" for type "${typeId}"`);
    });
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
        // renderDetail is synchronous: stash the per-domain states so the
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
        locale: str(user.locale),
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
        roles: (membership.roles ?? [])
          .map((r) => str(r.slug))
          .filter(Boolean)
          .join(", "),
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
        activeUsers: directory.metadata?.users?.active ?? 0,
        inactiveUsers: directory.metadata?.users?.inactive ?? 0,
        groupCount: directory.metadata?.groups ?? 0,
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
        resourceTypeSlug: str(role.resource_type_slug),
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

  private mapOrganizationDomain(
    accountId: string,
    domain: WosOrganizationDomain,
  ): ResourceInstance {
    const id = str(domain.id);
    const createdAt = str(domain.created_at) || new Date().toISOString();
    const organizationId = str(domain.organization_id);
    const prefix = str(domain.verification_prefix);
    const name = str(domain.domain);
    // DNS verification publishes the token as a TXT record at
    // `{verification_prefix}.{domain}`.
    const txtRecordName = prefix && name ? `${prefix}.${name}` : "";
    const txtRecordValue = str(domain.verification_token);
    return {
      id: `${accountId}:organization-domain:${id}`,
      pluginId: "workos",
      resourceTypeId: "organization-domain",
      accountId,
      displayName: name || id,
      externalId: id,
      fields: {
        domain: name,
        state: str(domain.state),
        verificationStrategy: str(domain.verification_strategy),
        txtRecordName,
        txtRecordValue,
        organizationId,
        createdAt,
      },
      resolvedOutputs: { domainId: id, txtRecordName, txtRecordValue },
      secretStates: [],
      ...(organizationId
        ? { parentResourceId: `${accountId}:organization:${organizationId}` }
        : {}),
      createdAt,
      updatedAt: str(domain.updated_at) || createdAt,
    };
  }

  private mapOrganizationRole(accountId: string, orgId: string, role: WosRole): ResourceInstance {
    const slug = str(role.slug);
    const externalId = `${orgId}/${slug}`;
    const createdAt = str(role.created_at) || new Date().toISOString();
    return {
      id: `${accountId}:organization-role:${externalId}`,
      pluginId: "workos",
      resourceTypeId: "organization-role",
      accountId,
      displayName: str(role.name) || slug,
      externalId,
      fields: {
        slug,
        name: str(role.name),
        description: str(role.description),
        permissions: (role.permissions ?? []).join(", "),
        resourceTypeSlug: str(role.resource_type_slug),
        organizationId: orgId,
        createdAt,
      },
      resolvedOutputs: { roleSlug: slug },
      secretStates: [],
      parentResourceId: `${accountId}:organization:${orgId}`,
      createdAt,
      updatedAt: str(role.updated_at) || createdAt,
    };
  }

  private mapPermission(accountId: string, permission: WosPermission): ResourceInstance {
    const slug = str(permission.slug);
    const createdAt = str(permission.created_at) || new Date().toISOString();
    return {
      id: `${accountId}:permission:${slug}`,
      pluginId: "workos",
      resourceTypeId: "permission",
      accountId,
      displayName: str(permission.name) || slug,
      externalId: slug,
      fields: {
        slug,
        name: str(permission.name),
        description: str(permission.description),
        system: permission.system === true,
        resourceTypeSlug: str(permission.resource_type_slug),
        createdAt,
      },
      resolvedOutputs: { permissionSlug: slug },
      secretStates: [],
      createdAt,
      updatedAt: str(permission.updated_at) || createdAt,
    };
  }

  private mapApiKey(accountId: string, orgId: string, key: WosApiKey): ResourceInstance {
    const id = str(key.id);
    const externalId = `${orgId}/${id}`;
    const createdAt = str(key.created_at) || new Date().toISOString();
    return {
      id: `${accountId}:organization-api-key:${externalId}`,
      pluginId: "workos",
      resourceTypeId: "organization-api-key",
      accountId,
      displayName: str(key.name) || str(key.obfuscated_value) || id,
      externalId,
      fields: {
        name: str(key.name),
        obfuscatedValue: str(key.obfuscated_value),
        permissions: (key.permissions ?? []).join(", "),
        lastUsedAt: str(key.last_used_at),
        expiresAt: str(key.expires_at),
        organizationId: orgId,
        createdAt,
      },
      resolvedOutputs: { apiKeyId: id },
      secretStates: [],
      parentResourceId: `${accountId}:organization:${orgId}`,
      createdAt,
      updatedAt: str(key.updated_at) || createdAt,
    };
  }

  private mapFeatureFlag(accountId: string, flag: WosFeatureFlag): ResourceInstance {
    const slug = str(flag.slug);
    const createdAt = str(flag.created_at) || new Date().toISOString();
    const owner = flag.owner
      ? [str(flag.owner.first_name), str(flag.owner.last_name)].filter(Boolean).join(" ") ||
        str(flag.owner.email)
      : "";
    return {
      id: `${accountId}:feature-flag:${slug}`,
      pluginId: "workos",
      resourceTypeId: "feature-flag",
      accountId,
      displayName: str(flag.name) || slug,
      externalId: slug,
      fields: {
        slug,
        name: str(flag.name),
        description: str(flag.description),
        enabled: flag.enabled === true,
        defaultValue: flag.default_value === true,
        tags: (flag.tags ?? []).join(", "),
        owner,
        createdAt,
      },
      resolvedOutputs: { flagSlug: slug },
      secretStates: [],
      createdAt,
      updatedAt: str(flag.updated_at) || createdAt,
    };
  }

  private mapGroup(accountId: string, group: Partial<WosGroup>): ResourceInstance {
    const id = str(group.id);
    const orgId = str(group.organization_id);
    const externalId = `${orgId}/${id}`;
    const createdAt = str(group.created_at) || new Date().toISOString();
    return {
      id: `${accountId}:group:${externalId}`,
      pluginId: "workos",
      resourceTypeId: "group",
      accountId,
      displayName: str(group.name) || id,
      externalId,
      fields: {
        name: str(group.name),
        description: str(group.description),
        organizationId: orgId,
        createdAt,
      },
      resolvedOutputs: { groupId: id },
      secretStates: [],
      ...(orgId ? { parentResourceId: `${accountId}:organization:${orgId}` } : {}),
      createdAt,
      updatedAt: str(group.updated_at) || createdAt,
    };
  }

  // -------------------------------------------------------------------------
  // Metrics
  // -------------------------------------------------------------------------

  /**
   * An organization's SSO, session and Directory Sync activity, counted per
   * bucket from the Events API. WorkOS has no metrics endpoint; the events
   * are the record. The API answers at most 30 days per request (and keeps
   * 90), so a longer window is clamped to its latest 30 days.
   */
  fetchMetricSeries(
    resourceTypeId: string,
    resourceId: string,
    _accountId: string,
    timeRange?: { startMs: number; endMs: number },
  ): PluginEffect<MetricSeries[]> {
    return attempt(async () => {
      if (resourceTypeId !== "organization") return [];
      const endMs = timeRange?.endMs ?? Date.now();
      const startMs = Math.max(
        timeRange?.startMs ?? endMs - METRICS_DEFAULT_RANGE_MS,
        endMs - EVENTS_MAX_RANGE_MS,
      );
      const events = ORGANIZATION_METRIC_SERIES.flatMap((series) => [...series.events]);
      const organizationId = externalIdOf(resourceId);
      const rangeEnd = new Date(endMs).toISOString();
      const read = await readEventWindow(
        (paging) =>
          this.api.get("/events", {
            query: {
              organization_id: organizationId,
              range_end: rangeEnd,
              order: "desc",
              events,
              ...paging,
            },
          }),
        startMs,
        endMs,
      );

      const timestamps = read.events
        .map((event) => ({ name: str(event.event), at: Date.parse(str(event.created_at)) }))
        .filter((event) => Number.isFinite(event.at));
      const bucketMs = Math.max(
        60_000,
        Math.ceil((endMs - startMs) / METRIC_BUCKETS / 60_000) * 60_000,
      );
      const buckets: number[] = [];
      // What a read could not reach is unknown, not zero, so the chart leaves it out.
      for (let at = startMs; at < endMs; at += bucketMs) {
        if (at >= read.fromMs && at + bucketMs <= read.toMs) buckets.push(at);
      }

      return ORGANIZATION_METRIC_SERIES.map((series) => {
        const counts = new Map<number, number>(buckets.map((at) => [at, 0]));
        for (const event of timestamps) {
          if (!series.events.includes(event.name)) continue;
          const bucket = startMs + Math.floor((event.at - startMs) / bucketMs) * bucketMs;
          const current = counts.get(bucket);
          if (current !== undefined) counts.set(bucket, current + 1);
        }
        return {
          label: series.label,
          unit: "count",
          points: buckets.map((timestamp) => ({ timestamp, value: counts.get(timestamp) ?? 0 })),
        };
      });
    });
  }

  // -------------------------------------------------------------------------
  // Dashboard stats
  // -------------------------------------------------------------------------

  fetchDashboardStats(
    resourceTypeId: string,
    resourceId: string,
    _accountId: string,
  ): PluginEffect<DashboardStat[]> {
    return attempt(async () => {
      const id = externalIdOf(resourceId);

      if (resourceTypeId === "organization") {
        const [memberships, invitations, connections, directories] = await Promise.all([
          this.fetchMemberships(id).catch(noneUnlessIncomplete),
          this.fetchInvitations(id).catch(noneUnlessIncomplete),
          this.api
            .getAll("/connections", "data", { query: { organization_id: id } })
            .catch(noneUnlessIncomplete),
          this.fetchDirectories(id).catch(noneUnlessIncomplete),
        ]);
        const pending = invitations.filter((invitation) => invitation.state === "pending").length;
        const active = memberships.filter((membership) => membership.status === "active").length;
        const inactive = memberships.filter(
          (membership) => membership.status === "inactive",
        ).length;
        return [
          { label: "Members", value: String(active) },
          { label: "Inactive Members", value: String(inactive) },
          { label: "Pending Invites", value: String(pending) },
          { label: "SSO Connections", value: String(connections.length) },
          { label: "Directories", value: String(directories.length) },
        ];
      }

      if (resourceTypeId === "directory") {
        // The directory carries its own sync counts; page through users and
        // groups only when an older response lacks them.
        const directory = await this.api
          .get(`/directories/${pathEncode(id)}`)
          .catch(() => undefined);
        if (directory?.metadata) {
          return [
            { label: "Active Users", value: String(directory.metadata.users?.active ?? 0) },
            { label: "Inactive Users", value: String(directory.metadata.users?.inactive ?? 0) },
            { label: "Synced Groups", value: String(directory.metadata.groups ?? 0) },
          ];
        }
        const [users, groups] = await Promise.all([
          this.fetchDirectoryUsers(id).catch(noneUnlessIncomplete),
          this.fetchDirectoryGroups(id).catch(noneUnlessIncomplete),
        ]);
        return [
          { label: "Synced Users", value: String(users.length) },
          { label: "Synced Groups", value: String(groups.length) },
        ];
      }

      return [];
    });
  }

  // -------------------------------------------------------------------------
  // Create
  // -------------------------------------------------------------------------

  getCreateConfig(typeId: string, parentResourceId?: string): PluginEffect<CreateResourceConfig> {
    return attempt(async () => {
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
                  "Optional organization domains. Added as pending; verify them in the WorkOS dashboard.",
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
                  { id: "false", label: "No, WorkOS verifies on first sign-in" },
                  { id: "true", label: "Yes, mark as already verified" },
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
                kind: "policy-picker",
                required: true,
                policies: WEBHOOK_EVENTS.map((event) => ({
                  id: event,
                  label: event,
                  category: event.split(".")[0] ?? event,
                })),
                description: "Event types WorkOS delivers to this endpoint.",
              },
            ],
          };
        case "organization-domain":
          return {
            fields: [
              ...(await this.organizationPickerField(parentResourceId)),
              {
                key: "domain",
                label: "Domain",
                kind: "text",
                required: true,
                placeholder: "example.com",
                description:
                  "Added as pending. Publish the TXT record the domain page shows, then choose Verify.",
              },
            ],
          };
        case "organization-role":
          return {
            fields: [
              ...(await this.organizationPickerField(parentResourceId)),
              {
                key: "name",
                label: "Name",
                kind: "text",
                required: true,
                placeholder: "Billing admin",
              },
              {
                key: "slug",
                label: "Slug",
                kind: "text",
                required: false,
                placeholder: "org-billing-admin",
                description:
                  "Optional. Must start with org- and use lowercase letters, numbers, hyphens and underscores. Generated from the name when blank.",
              },
              { key: "description", label: "Description", kind: "text", required: false },
              {
                key: "permissions",
                label: "Permissions",
                kind: "policy-picker",
                required: false,
                policies: await this.permissionOptions(),
              },
            ],
          };
        case "permission":
          return {
            fields: [
              {
                key: "slug",
                label: "Slug",
                kind: "text",
                required: true,
                placeholder: "invoices:read",
                description:
                  "Lowercase letters, numbers, hyphens, underscores, colons, periods and asterisks.",
              },
              {
                key: "name",
                label: "Name",
                kind: "text",
                required: true,
                placeholder: "Read invoices",
              },
              { key: "description", label: "Description", kind: "text", required: false },
            ],
          };
        case "organization-api-key":
          return {
            fields: [
              ...(await this.organizationPickerField(parentResourceId)),
              {
                key: "name",
                label: "Name",
                kind: "text",
                required: true,
                placeholder: "CI pipeline",
              },
              {
                key: "permissions",
                label: "Permissions",
                kind: "policy-picker",
                required: false,
                policies: await this.permissionOptions(),
              },
              {
                key: "expiresAt",
                label: "Expires",
                kind: "datetime",
                required: false,
                description: "Optional. Leave empty for a key that does not expire.",
              },
            ],
          };
        case "group":
          return {
            fields: [
              ...(await this.organizationPickerField(parentResourceId)),
              {
                key: "name",
                label: "Name",
                kind: "text",
                required: true,
                placeholder: "Engineering",
              },
              { key: "description", label: "Description", kind: "text", required: false },
            ],
          };
        default:
          throw new Error(`WorkOS plugin: cannot create resource type "${typeId}"`);
      }
    });
  }

  /**
   * An organization picker, unless the create was launched from an
   * organization's detail page: the parent already answers the question.
   */
  private async organizationPickerField(parentResourceId?: string): Promise<CreateFieldConfig[]> {
    if (parentResourceId) return [];
    const orgs = await this.fetchOrganizations(PICKER_READ).catch(noneUnlessIncomplete);
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
   * A role picker fed from the live role list (org-scoped roles when the
   * parent organization is known, environment roles otherwise) so the user
   * picks a name instead of typing a slug.
   */
  private async rolePickerField(parentResourceId?: string): Promise<CreateFieldConfig> {
    const request = parentResourceId
      ? this.api.get(
          `/authorization/organizations/${pathEncode(this.organizationIdOfParent(parentResourceId))}/roles`,
        )
      : this.api.get("/authorization/roles");
    const roles = await request.then((body) => body.data ?? []).catch((): WosRole[] => []);
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

  /** Every permission in the environment, as policy-picker options. */
  private async permissionOptions(): Promise<PolicyOption[]> {
    const permissions = await this.fetchPermissions().catch(noneUnlessIncomplete);
    return permissions
      .filter((permission) => permission.slug)
      .map((permission) => ({
        id: str(permission.slug),
        label: str(permission.name) || str(permission.slug),
        description: str(permission.slug),
        category: permission.system ? "System" : "Custom",
      }));
  }

  /**
   * Read the organization external id out of a parent resource id, refusing
   * parents of any other type: building organization-scoped URLs from a
   * non-organization id would silently target the wrong tenant.
   */
  private organizationIdOfParent(parentResourceId: string): string {
    const typeId = parentResourceId.split(":")[1];
    if (typeId !== "organization") {
      throw new Error(`WorkOS plugin: expected an organization parent, got "${typeId ?? ""}"`);
    }
    return externalIdOf(parentResourceId);
  }

  private resolveOrganizationId(fields: Record<string, string>, parentResourceId?: string): string {
    const organizationId = parentResourceId
      ? this.organizationIdOfParent(parentResourceId)
      : fields["organizationId"];
    if (!organizationId) throw new Error("WorkOS plugin: an organization is required");
    return organizationId;
  }

  createResource(
    typeId: string,
    accountId: string,
    fields: Record<string, string>,
    parentResourceId?: string,
  ): PluginEffect<ResourceInstance> {
    return attempt(async () => {
      switch (typeId) {
        case "organization": {
          // POST /organizations: domain_data entries need an explicit state;
          // "pending" defers verification to the dashboard.
          const domains = (fields["domains"] ?? "")
            .split(",")
            .map((domain) => domain.trim())
            .filter(Boolean);
          const org = await this.api.post("/organizations", {
            body: {
              name: fields["name"],
              ...(domains.length > 0
                ? { domain_data: domains.map((domain) => ({ domain, state: "pending" })) }
                : {}),
            },
          });
          return this.mapOrganization(accountId, org);
        }
        case "user": {
          const user = await this.api.post("/user_management/users", {
            body: {
              email: fields["email"],
              ...(fields["firstName"] ? { first_name: fields["firstName"] } : {}),
              ...(fields["lastName"] ? { last_name: fields["lastName"] } : {}),
              ...(fields["password"] ? { password: fields["password"] } : {}),
              ...(fields["emailVerified"] === "true" ? { email_verified: true } : {}),
            },
          });
          return this.mapUser(accountId, user);
        }
        case "organization-membership": {
          const organizationId = this.resolveOrganizationId(fields, parentResourceId);
          const userId = fields["userId"];
          if (!userId) throw new Error("WorkOS plugin: a user is required");
          const membership = await this.api.post("/user_management/organization_memberships", {
            body: {
              user_id: userId,
              organization_id: organizationId,
              ...(fields["roleSlug"] ? { role_slug: fields["roleSlug"] } : {}),
            },
          });
          const email = await this.fetchUserEmail(userId);
          return this.mapMembership(accountId, membership, email);
        }
        case "invitation": {
          const organizationId = this.resolveOrganizationId(fields, parentResourceId);
          const invitation = await this.api.post("/user_management/invitations", {
            body: {
              email: fields["email"],
              organization_id: organizationId,
              ...(fields["roleSlug"] ? { role_slug: fields["roleSlug"] } : {}),
              ...(fields["expiresInDays"]
                ? { expires_in_days: Number(fields["expiresInDays"]) }
                : {}),
            },
          });
          return this.mapInvitation(accountId, invitation);
        }
        case "role": {
          const role = await this.api.post("/authorization/roles", {
            body: {
              slug: fields["slug"],
              name: fields["name"],
              ...(fields["description"] ? { description: fields["description"] } : {}),
            },
          });
          return this.mapRole(accountId, role);
        }
        case "webhook-endpoint": {
          const events = pickedList(fields["events"]);
          if (events.length === 0) {
            throw new Error("WorkOS plugin: at least one event type is required");
          }
          const endpoint = await this.api.post("/webhook_endpoints", {
            body: { endpoint_url: fields["endpointUrl"], events },
          });
          return this.mapWebhookEndpoint(accountId, endpoint);
        }
        case "organization-domain": {
          const organizationId = this.resolveOrganizationId(fields, parentResourceId);
          const domain = (fields["domain"] ?? "").trim().toLowerCase();
          if (!domain) throw new Error("WorkOS plugin: a domain is required");
          const created = await this.api.post("/organization_domains", {
            body: { domain, organization_id: organizationId },
          });
          return this.mapOrganizationDomain(accountId, created);
        }
        case "organization-role": {
          const organizationId = this.resolveOrganizationId(fields, parentResourceId);
          const slug = (fields["slug"] ?? "").trim();
          if (slug && !/^org-[a-z0-9_-]+$/.test(slug)) {
            throw new Error(
              "WorkOS plugin: organization role slugs start with org- and use lowercase letters, numbers, hyphens and underscores",
            );
          }
          const encodedOrg = pathEncode(organizationId);
          let role = await this.api.post(`/authorization/organizations/${encodedOrg}/roles`, {
            body: {
              name: fields["name"],
              ...(slug ? { slug } : {}),
              ...(fields["description"] ? { description: fields["description"] } : {}),
            },
          });
          const permissions = pickedList(fields["permissions"]);
          if (permissions.length > 0) {
            role = await this.api.put(
              `/authorization/organizations/${encodedOrg}/roles/${pathEncode(str(role.slug))}/permissions`,
              { body: { permissions } },
            );
          }
          return this.mapOrganizationRole(accountId, organizationId, role);
        }
        case "permission": {
          const slug = (fields["slug"] ?? "").trim();
          if (!/^[a-z0-9_.:*-]+$/.test(slug)) {
            throw new Error(
              "WorkOS plugin: permission slugs use lowercase letters, numbers, hyphens, underscores, colons, periods and asterisks",
            );
          }
          const permission = await this.api.post("/authorization/permissions", {
            body: {
              slug,
              name: fields["name"],
              ...(fields["description"] ? { description: fields["description"] } : {}),
            },
          });
          return this.mapPermission(accountId, permission);
        }
        case "organization-api-key": {
          const organizationId = this.resolveOrganizationId(fields, parentResourceId);
          const permissions = pickedList(fields["permissions"]);
          const expiresAt = (fields["expiresAt"] ?? "").trim();
          if (expiresAt && !(Date.parse(expiresAt) > Date.now())) {
            throw new Error("WorkOS plugin: the expiry must be in the future");
          }
          const key = await this.api.post(`/organizations/${pathEncode(organizationId)}/api_keys`, {
            body: {
              name: fields["name"],
              ...(permissions.length > 0 ? { permissions } : {}),
              ...(expiresAt ? { expires_at: new Date(expiresAt).toISOString() } : {}),
            },
          });
          const created = this.mapApiKey(accountId, organizationId, key);
          // The full value is returned on this response only.
          if (key.value)
            created.resolvedOutputs = { ...created.resolvedOutputs, apiKey: key.value };
          return created;
        }
        case "group": {
          const organizationId = this.resolveOrganizationId(fields, parentResourceId);
          const group: Partial<WosGroup> = await this.api.post(
            `/organizations/${pathEncode(organizationId)}/groups`,
            {
              body: {
                name: fields["name"],
                ...(fields["description"] ? { description: fields["description"] } : {}),
              },
            },
          );
          return this.mapGroup(accountId, { organization_id: organizationId, ...group });
        }
        default:
          throw new Error(`WorkOS plugin: cannot create resource type "${typeId}"`);
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
      const id = externalIdOf(resourceId);
      switch (typeId) {
        case "organization": {
          const org = await this.api.put(`/organizations/${pathEncode(id)}`, {
            body: {
              ...(fields["name"] ? { name: fields["name"] } : {}),
              ...(fields["externalId"] !== undefined
                ? { external_id: fields["externalId"].trim() || null }
                : {}),
            },
          });
          return this.mapOrganization(accountId, org);
        }
        case "user": {
          const body: ApiBody<operations["UserlandUsersController_update[0]"]> = {};
          if (fields["email"]) body["email"] = fields["email"];
          if (fields["firstName"] !== undefined) body["first_name"] = fields["firstName"];
          if (fields["lastName"] !== undefined) body["last_name"] = fields["lastName"];
          if (fields["emailVerified"] !== undefined) {
            body["email_verified"] = fields["emailVerified"] === "true";
          }
          if (fields["externalId"] !== undefined) {
            body["external_id"] = fields["externalId"].trim() || null;
          }
          if (fields["locale"] !== undefined) body["locale"] = fields["locale"].trim() || null;
          const user = await this.api.put(`/user_management/users/${pathEncode(id)}`, { body });
          return this.mapUser(accountId, user);
        }
        case "organization-membership": {
          const membership = await this.api.put(
            `/user_management/organization_memberships/${pathEncode(id)}`,
            { body: { role_slug: fields["role"] } },
          );
          const email = await this.fetchUserEmail(str(membership.user_id));
          return this.mapMembership(accountId, membership, email);
        }
        case "role": {
          const role = await this.api.patch(`/authorization/roles/${pathEncode(id)}`, {
            body: {
              ...(fields["name"] !== undefined ? { name: fields["name"] } : {}),
              ...(fields["description"] !== undefined
                ? { description: fields["description"] }
                : {}),
            },
          });
          return this.mapRole(accountId, role);
        }
        case "webhook-endpoint": {
          const body: ApiBody<operations["WebhookEndpointsController_update"]> = {};
          if (fields["endpointUrl"] !== undefined) body["endpoint_url"] = fields["endpointUrl"];
          if (fields["status"] !== undefined) body["status"] = fields["status"];
          if (fields["events"] !== undefined) {
            const events = pickedList(fields["events"]);
            const unknown = events.filter((event) => !WEBHOOK_EVENTS.includes(event));
            if (unknown.length > 0) {
              throw new Error(`WorkOS plugin: unknown webhook events: ${unknown.join(", ")}`);
            }
            if (events.length === 0) {
              throw new Error("WorkOS plugin: at least one event type is required");
            }
            body["events"] = events;
          }
          const endpoint = await this.api.patch(`/webhook_endpoints/${pathEncode(id)}`, { body });
          return this.mapWebhookEndpoint(accountId, endpoint);
        }
        case "connection": {
          const connection = await this.api.patch(`/connections/${pathEncode(id)}`, {
            body: { ...(fields["name"] ? { name: fields["name"] } : {}) },
          });
          return this.mapConnection(accountId, connection);
        }
        case "organization-role": {
          const [orgId, slug] = orgScoped(id);
          const role = await this.api.patch(
            `/authorization/organizations/${pathEncode(orgId)}/roles/${pathEncode(slug)}`,
            {
              body: {
                ...(fields["name"] !== undefined ? { name: fields["name"] } : {}),
                ...(fields["description"] !== undefined
                  ? { description: fields["description"] || null }
                  : {}),
              },
            },
          );
          return this.mapOrganizationRole(accountId, orgId, role);
        }
        case "permission": {
          const permission = await this.api.patch(`/authorization/permissions/${pathEncode(id)}`, {
            body: {
              ...(fields["name"] !== undefined ? { name: fields["name"] } : {}),
              ...(fields["description"] !== undefined
                ? { description: fields["description"] || null }
                : {}),
            },
          });
          return this.mapPermission(accountId, permission);
        }
        case "feature-flag": {
          if (fields["enabled"] !== undefined) {
            const flag =
              fields["enabled"] === "true"
                ? await this.api.put(`/feature-flags/${pathEncode(id)}/enable`)
                : await this.api.put(`/feature-flags/${pathEncode(id)}/disable`);
            return this.mapFeatureFlag(accountId, flag);
          }
          return runPluginEffect(this.getResource(typeId, resourceId, accountId));
        }
        case "group": {
          const [orgId, groupId] = orgScoped(id);
          const group = await this.api.patch(
            `/organizations/${pathEncode(orgId)}/groups/${pathEncode(groupId)}`,
            {
              body: {
                ...(fields["name"] !== undefined ? { name: fields["name"] } : {}),
                ...(fields["description"] !== undefined
                  ? { description: fields["description"] || null }
                  : {}),
              },
            },
          );
          return this.mapGroup(accountId, group);
        }
        default:
          throw new Error(`WorkOS plugin: cannot update resource type "${typeId}"`);
      }
    });
  }

  // -------------------------------------------------------------------------
  // Delete + actions
  // -------------------------------------------------------------------------

  deleteResource(typeId: string, resourceId: string, _accountId: string): PluginEffect<void> {
    return attempt(async () => {
      const id = pathEncode(externalIdOf(resourceId));
      switch (typeId) {
        case "organization":
          await this.bodiless.delete(`/organizations/${id}`);
          return;
        case "user":
          await this.bodiless.delete(`/user_management/users/${id}`);
          return;
        case "organization-membership":
          await this.bodiless.delete(`/user_management/organization_memberships/${id}`);
          return;
        case "invitation":
          // Invitations have no DELETE: revoking is the removal operation.
          await this.api.post(`/user_management/invitations/${id}/revoke`);
          return;
        case "connection":
          await this.bodiless.delete(`/connections/${id}`);
          return;
        case "directory":
          await this.bodiless.delete(`/directories/${id}`);
          return;
        case "webhook-endpoint":
          await this.bodiless.delete(`/webhook_endpoints/${id}`);
          return;
        case "organization-domain":
          await this.bodiless.delete(`/organization_domains/${id}`);
          return;
        case "permission":
          await this.bodiless.delete(`/authorization/permissions/${id}`);
          return;
        case "organization-role": {
          const [orgId, slug] = orgScoped(externalIdOf(resourceId));
          await this.bodiless.delete(
            `/authorization/organizations/${pathEncode(orgId)}/roles/${pathEncode(slug)}`,
          );
          return;
        }
        case "organization-api-key": {
          const [, keyId] = orgScoped(externalIdOf(resourceId));
          await this.bodiless.delete(`/api_keys/${pathEncode(keyId)}`);
          return;
        }
        case "group": {
          const [orgId, groupId] = orgScoped(externalIdOf(resourceId));
          await this.bodiless.delete(
            `/organizations/${pathEncode(orgId)}/groups/${pathEncode(groupId)}`,
          );
          return;
        }
        default:
          throw new Error(`WorkOS plugin: cannot delete resource type "${typeId}"`);
      }
    });
  }

  invokeAction(
    typeId: string,
    resourceId: string,
    actionId: string,
    _accountId: string,
  ): PluginEffect<void> {
    return attempt(async () => {
      const id = pathEncode(externalIdOf(resourceId));

      if (typeId === "organization-membership") {
        if (actionId === "deactivate") {
          await this.api.put(`/user_management/organization_memberships/${id}/deactivate`);
          return;
        }
        if (actionId === "reactivate") {
          await this.api.put(`/user_management/organization_memberships/${id}/reactivate`);
          return;
        }
      }

      if (typeId === "invitation") {
        if (actionId === "resend") {
          await this.api.post(`/user_management/invitations/${id}/resend`);
          return;
        }
        if (actionId === "revoke") {
          await this.api.post(`/user_management/invitations/${id}/revoke`);
          return;
        }
      }

      if (typeId === "directory" && actionId === "sync") {
        // Queues an asynchronous sync; 202 means accepted, not finished.
        await this.api.post(`/directories/${id}/sync`);
        return;
      }

      if (typeId === "organization-domain" && actionId === "verify") {
        await this.api.post(`/organization_domains/${id}/verify`);
        return;
      }

      if (typeId === "organization-api-key" && actionId === "expire") {
        const [, keyId] = orgScoped(externalIdOf(resourceId));
        // No `expires_at` expires the key immediately.
        await this.api.post(`/api_keys/${pathEncode(keyId)}/expire`, { body: {} });
        return;
      }

      if (typeId === "feature-flag" && actionId === "enable") {
        await this.api.put(`/feature-flags/${id}/enable`);
        return;
      }

      if (typeId === "feature-flag" && actionId === "disable") {
        await this.api.put(`/feature-flags/${id}/disable`);
        return;
      }

      if (typeId === "user") {
        if (actionId === "send-verification-email") {
          await this.api.post(`/user_management/users/${id}/email_verification/send`);
          return;
        }
        if (actionId === "revoke-sessions") {
          const sessions = await this.fetchSessions(externalIdOf(resourceId));
          const active = sessions.filter((session) => session.status === "active" && session.id);
          for (const session of active) {
            await this.api.post("/user_management/sessions/revoke", {
              body: { session_id: session.id },
            });
          }
          return;
        }
      }

      throw new Error(`WorkOS plugin: unknown action "${actionId}" for type "${typeId}"`);
    });
  }

  /**
   * Form-driven actions: role permission sets, feature flag targets and group
   * membership. Form values arrive JSON-encoded in `args[0]`.
   */
  executeNoSqlCommand(
    typeId: string,
    resourceId: string,
    _accountId: string,
    command: string,
    args: (string | number)[],
  ): PluginEffect<unknown> {
    return attempt(async () => {
      const values: Record<string, string> = JSON.parse(String(args[0] ?? "{}"));
      const id = externalIdOf(resourceId);

      if (command === "set-permissions" && (typeId === "role" || typeId === "organization-role")) {
        const permissions = pickedList(values["permissions"]);
        if (typeId === "role") {
          return this.api.put(`/authorization/roles/${pathEncode(id)}/permissions`, {
            body: { permissions },
          });
        }
        const [orgId, slug] = orgScoped(id);
        return this.api.put(
          `/authorization/organizations/${pathEncode(orgId)}/roles/${pathEncode(slug)}/permissions`,
          { body: { permissions } },
        );
      }

      if (typeId === "feature-flag" && (command === "add-target" || command === "remove-target")) {
        const target = values["target"] ?? "";
        // Targets are organizations or users, addressed by their own ids.
        if (!/^(org|user)_[A-Za-z0-9]+$/.test(target)) {
          throw new Error("WorkOS plugin: choose an organization or user to target");
        }
        const path = `/feature-flags/${pathEncode(id)}/targets/${pathEncode(target)}` as const;
        if (command === "add-target") {
          await this.bodiless.post(path);
        } else {
          await this.bodiless.delete(path);
        }
        return { ok: true };
      }

      if (typeId === "group" && (command === "add-member" || command === "remove-member")) {
        const [orgId, groupId] = orgScoped(id);
        const membershipId = values["membershipId"] ?? "";
        if (!membershipId) throw new Error("WorkOS plugin: choose a member");
        const base =
          `/organizations/${pathEncode(orgId)}/groups/${pathEncode(groupId)}/organization-memberships` as const;
        if (command === "add-member") {
          return this.api.post(base, { body: { organization_membership_id: membershipId } });
        }
        await this.bodiless.delete(`${base}/${pathEncode(membershipId)}`);
        return { ok: true };
      }

      throw new Error(`WorkOS plugin: unknown command "${command}" for type "${typeId}"`);
    });
  }

  /** Admin Portal links for an organization, minted fresh and shown once. */
  exportCredential(
    typeId: string,
    resourceId: string,
    _accountId: string,
    formatId: string,
  ): PluginEffect<CredentialExport> {
    return attempt(async () => {
      const intent = formatId.replace(/^portal-/, "");
      if (typeId !== "organization" || !formatId.startsWith("portal-") || !isPortalIntent(intent)) {
        throw new Error(`WorkOS plugin: unknown credential format "${formatId}"`);
      }
      const organization = externalIdOf(resourceId);
      const body = await this.api.post("/portal/generate_link", {
        body: { organization, intent },
      });
      const link = str(body.link);
      if (!link) throw new Error("WorkOS plugin: WorkOS returned no Admin Portal link");
      return {
        content: link,
        filename: `${organization}-admin-portal-${intent}.txt`,
        mimeType: "text/plain",
        fields: [
          {
            label: "Admin Portal link",
            value: link,
            sensitive: true,
            hint: "Expires in 5 minutes",
          },
        ],
        warning:
          "Send this link to the organization's IT admin now. Anyone holding it can configure the organization until it expires five minutes after creation.",
      };
    });
  }

  /** Recent WorkOS events for an organization (the Events API). */
  getLogs(
    typeId: string,
    resourceId: string,
    _accountId: string,
    params: LogsFetchParams,
  ): PluginEffect<LogsFetchResult> {
    return attempt(async () => {
      if (typeId !== "organization") throw new Error("WorkOS plugin: only organizations have logs");
      const organizationId = externalIdOf(resourceId);
      const wanted = Math.min(Math.max(params.tailLines ?? 100, 1), 100);
      const events = await readEventTail(
        (paging) =>
          this.api.get("/events", {
            query: {
              organization_id: organizationId,
              order: "desc",
              // `events` is required and repeats per value.
              events: [...ORGANIZATION_LOG_EVENTS],
              ...paging,
            },
          }),
        wanted,
        Date.now(),
      );
      const lines = events.map((event) => {
        const data = event.data ?? {};
        const subject =
          eventText(data["email"]) ||
          eventText(data["name"]) ||
          eventText(data["domain"]) ||
          eventText(data["id"]);
        const actor = event.context?.actor;
        const by = actor ? ` by ${str(actor.name) || str(actor.id)} (${str(actor.source)})` : "";
        return `${str(event.created_at)} ${str(event.event)} ${subject}${by}`.trim();
      });
      return {
        text: lines.map((line) => `${line}\n`).join(""),
        containers: ["events"],
        activeContainer: "events",
      };
    });
  }

  /**
   * Load what the synchronous detail views need beyond the synced record:
   * picker options for form actions and a user's sessions.
   */
  enrichDetail(resource: ResourceInstance): PluginEffect<ResourceInstance> {
    return attempt(async () => {
      const id = externalIdOf(resource.id);
      const extra: Record<string, string> = {};
      switch (resource.resourceTypeId) {
        case "role":
        case "organization-role":
          extra["__permissionOptions__"] = JSON.stringify(await this.permissionOptions());
          break;
        case "feature-flag": {
          const [orgs, users] = await Promise.all([
            this.fetchOrganizations(PICKER_READ).catch(noneUnlessIncomplete),
            this.fetchUsers(PICKER_READ).catch(noneUnlessIncomplete),
          ]);
          extra["__targets__"] = JSON.stringify([
            ...orgs.map((org) => ({
              id: str(org.id),
              label: `Organization: ${str(org.name) || str(org.id)}`,
            })),
            ...users.map((user) => ({
              id: str(user.id),
              label: `User: ${str(user.email) || str(user.id)}`,
            })),
          ]);
          break;
        }
        case "group": {
          const [orgId, groupId] = orgScoped(id);
          const [members, memberships, emails] = await Promise.all([
            this.api
              .getAll(
                `/organizations/${pathEncode(orgId)}/groups/${pathEncode(groupId)}/organization-memberships`,
                "data",
                PICKER_READ,
              )
              .catch(noneUnlessIncomplete),
            // Only an active membership is offered, as before: the document does not
            // say a deactivated or pending one can join a group.
            this.fetchMemberships(orgId, ["active"]).catch(noneUnlessIncomplete),
            this.fetchUserEmailMap(PICKER_READ),
          ]);
          const label = (m: WosMemberRow) =>
            emails.get(str(m.user_id)) || str(m.user_id) || str(m.id);
          const memberIds = new Set(members.map((m) => str(m.id)));
          extra["__members__"] = JSON.stringify(
            members.map((m) => ({ id: str(m.id), label: label(m), status: str(m.status) })),
          );
          extra["__candidates__"] = JSON.stringify(
            memberships
              .filter((m) => m.id && !memberIds.has(str(m.id)))
              .map((m) => ({ id: str(m.id), label: label(m) })),
          );
          break;
        }
        case "user": {
          // Newest first by the document's default, and the table shows 50 of a page of 100.
          const sessions = await this.fetchSessions(id, { maxPages: 1, partial: true }).catch(
            noneUnlessIncomplete,
          );
          extra["__sessions__"] = JSON.stringify(sessions.slice(0, 50));
          break;
        }
        default:
          return resource;
      }
      return { ...resource, resolvedOutputs: { ...resource.resolvedOutputs, ...extra } };
    });
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
      case "organization-domain":
        return this.renderOrganizationDomainDetail(resource);
      case "organization-role":
        return this.renderRoleDetail(resource);
      case "permission":
        return this.renderPermissionDetail(resource);
      case "organization-api-key":
        return this.renderApiKeyDetail(resource);
      case "feature-flag":
        return this.renderFeatureFlagDetail(resource);
      case "group":
        return this.renderGroupDetail(resource);
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
      case "organization-domain":
        status = domainStateDot(String(fields["state"] ?? ""));
        break;
      case "organization-api-key":
        status = this.apiKeyStatus(resource);
        break;
      case "feature-flag":
        status = fields["enabled"] === true ? "healthy" : "degraded";
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
      logs: { defaultTailLines: 100 },
      metricsCapability: { defaultTimeRangeMs: METRICS_DEFAULT_RANGE_MS },
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
                { key: "Locale", value: String(fields["locale"] ?? "") || "—" },
                { key: "Last Sign-In", value: String(fields["lastSignInAt"] ?? "") || "Never" },
                { key: "Created", value: String(fields["createdAt"] ?? "") || "—" },
              ],
            },
          ],
        },
        ...this.sessionSections(resource),
      ],
      headerActions: [
        { kind: "action", label: "Refresh", action: { type: "refresh-resource" } },
        ...(verified
          ? []
          : [
              {
                kind: "action" as const,
                label: "Send verification email",
                action: {
                  type: "plugin-action" as const,
                  actionId: "send-verification-email",
                  successMessage: "Verification email sent.",
                },
              },
            ]),
        {
          kind: "action",
          label: "Sign out everywhere",
          variant: "danger",
          action: {
            type: "plugin-action",
            actionId: "revoke-sessions",
            confirmMessage:
              "Revoke every active session for this user? They are signed out of every device and must sign in again.",
            successMessage: "Sessions revoked.",
          },
        },
      ],
    };
  }

  private sessionSections(resource: ResourceInstance): DetailViewSchema["sections"] {
    const sessions = this.stashed<WosSession[]>(resource, "__sessions__", []);
    if (sessions.length === 0) return [];
    return [
      {
        kind: "section",
        title: `Sessions (${sessions.length})`,
        children: [
          {
            kind: "table",
            columns: [
              { key: "status", label: "Status", width: "narrow" },
              { key: "method", label: "Method" },
              { key: "ip", label: "IP address", mono: true },
              { key: "agent", label: "User agent" },
              { key: "created", label: "Started" },
              { key: "expires", label: "Expires" },
            ],
            rows: sessions.map((session) => ({
              cells: {
                status: str(session.status),
                method: session.impersonator
                  ? `impersonation by ${str(session.impersonator.email)}`
                  : str(session.auth_method),
                ip: str(session.ip_address),
                agent: str(session.user_agent),
                created: str(session.created_at),
                expires: str(session.ended_at) || str(session.expires_at),
              },
            })),
          },
        ],
      },
    ];
  }

  /** Read a JSON value `enrichDetail` stashed in `resolvedOutputs`. */
  private stashed<T>(resource: ResourceInstance, key: string, fallback: T): T {
    const raw = resource.resolvedOutputs[key];
    if (!raw) return fallback;
    try {
      const parsed: T = JSON.parse(raw);
      return parsed;
    } catch {
      return fallback;
    }
  }

  private renderMembershipDetail(resource: ResourceInstance): DetailViewSchema {
    const fields = resource.fields;
    const status = String(fields["status"] ?? "");
    const directoryManaged = fields["directoryManaged"] === true;

    const headerActions: DetailViewSchema["headerActions"] = [
      { kind: "action", label: "Refresh", action: { type: "refresh-resource" } },
    ];
    // Directory-managed memberships belong to Directory Sync: manual
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
                { key: "All Roles", value: String(fields["roles"] ?? "") || "—" },
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
                      "This membership is managed by Directory Sync; the directory provider would overwrite changes made here.",
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
      subtitle: joinSubtitle("SSO connection", fields["connectionType"]),
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
                "Set up and reconfigure connections through the organization's Admin Portal link (Get credentials on the organization) or the WorkOS dashboard. Rename or delete them here.",
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
      subtitle: joinSubtitle("Directory", fields["type"]),
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
                { key: "Active Users", value: String(fields["activeUsers"] ?? 0) },
                { key: "Inactive Users", value: String(fields["inactiveUsers"] ?? 0) },
                { key: "Groups", value: String(fields["groupCount"] ?? 0) },
                { key: "Created", value: String(fields["createdAt"] ?? "") || "—" },
              ],
            },
            ...(state === "invalid_credentials"
              ? [
                  {
                    kind: "text" as const,
                    content:
                      "The directory provider is rejecting WorkOS's credentials. Reconnect it from the dashboard or an Admin Portal session.",
                  },
                ]
              : []),
          ],
        },
      ],
      headerActions: [
        { kind: "action", label: "Refresh", action: { type: "refresh-resource" } },
        ...(state === "linked"
          ? [
              {
                kind: "action" as const,
                label: "Sync now",
                action: {
                  type: "plugin-action" as const,
                  actionId: "sync",
                  successMessage: "Sync queued. Changes arrive as the provider responds.",
                },
              },
            ]
          : []),
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
              content: "Read-only. The identity provider owns this record.",
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
              content: "Read-only. The identity provider owns this group.",
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

    const options = this.stashed<PolicyOption[]>(resource, "__permissionOptions__", []);
    const headerActions: DetailViewSchema["headerActions"] = [
      { kind: "action", label: "Refresh", action: { type: "refresh-resource" } },
    ];
    if (options.length > 0) {
      headerActions.push({
        kind: "action",
        label: "Edit permissions…",
        action: {
          type: "prompt-nosql-command",
          command: "set-permissions",
          title: "Role permissions",
          description:
            "Replaces the role's permissions with this selection. Everyone holding the role is affected immediately.",
          fields: [
            {
              key: "permissions",
              label: "Permissions",
              kind: "policy-picker",
              required: false,
              policies: options,
              defaultValue: JSON.stringify(permissions),
            },
          ],
          submitLabel: "Save permissions",
        },
      });
    }

    return {
      title: resource.displayName,
      subtitle:
        resource.resourceTypeId === "organization-role"
          ? "WorkOS organization role"
          : "WorkOS role",
      status: { kind: "status-dot", status: "info" },
      sections,
      headerActions,
    };
  }

  private apiKeyStatus(resource: ResourceInstance): ResourceStatus {
    const expiresAt = Date.parse(String(resource.fields["expiresAt"] ?? ""));
    if (Number.isFinite(expiresAt) && expiresAt <= Date.now()) return "error";
    return "healthy";
  }

  private kv(
    resource: ResourceInstance,
    rows: Array<[string, string]>,
  ): DetailViewSchema["sections"][number]["children"][number] {
    return {
      kind: "key-value-list",
      items: rows.map(([label, key]) => ({
        key: label,
        value:
          typeof resource.fields[key] === "boolean"
            ? resource.fields[key]
              ? "Yes"
              : "No"
            : String(resource.fields[key] ?? "") || "—",
      })),
    };
  }

  private renderOrganizationDomainDetail(resource: ResourceInstance): DetailViewSchema {
    const fields = resource.fields;
    const state = String(fields["state"] ?? "");
    const verified = state === "verified" || state === "legacy_verified";
    const txtName = String(fields["txtRecordName"] ?? "");
    const txtValue = String(fields["txtRecordValue"] ?? "");
    return {
      title: resource.displayName,
      subtitle: `Organization domain · ${state || "unknown"}`,
      status: { kind: "status-dot", status: domainStateDot(state) },
      sections: [
        {
          kind: "section",
          title: "Domain",
          children: [
            this.kv(resource, [
              ["Domain", "domain"],
              ["State", "state"],
              ["Verification", "verificationStrategy"],
              ["Organization ID", "organizationId"],
              ["Created", "createdAt"],
            ]),
          ],
        },
        ...(!verified && txtName && txtValue
          ? [
              {
                kind: "section" as const,
                title: "DNS verification",
                children: [
                  {
                    kind: "text" as const,
                    content: "Publish this TXT record at your DNS provider, then choose Verify.",
                  },
                  {
                    kind: "key-value-list" as const,
                    items: [
                      { key: "Type", value: "TXT" },
                      { key: "Name", value: txtName, copyable: true },
                      { key: "Value", value: txtValue, copyable: true },
                    ],
                  },
                ],
              },
            ]
          : []),
      ],
      headerActions: [
        { kind: "action", label: "Refresh", action: { type: "refresh-resource" } },
        ...(!verified
          ? [
              {
                kind: "action" as const,
                label: "Verify",
                action: {
                  type: "plugin-action" as const,
                  actionId: "verify",
                  successMessage: "Verification requested. Refresh to see the result.",
                },
              },
            ]
          : []),
      ],
    };
  }

  private renderPermissionDetail(resource: ResourceInstance): DetailViewSchema {
    const system = resource.fields["system"] === true;
    return {
      title: resource.displayName,
      subtitle: "WorkOS permission",
      status: { kind: "status-dot", status: "info" },
      sections: [
        {
          kind: "section",
          title: "Permission",
          children: [
            this.kv(resource, [
              ["Slug", "slug"],
              ["Name", "name"],
              ["Description", "description"],
              ["Resource type", "resourceTypeSlug"],
              ["System", "system"],
              ["Created", "createdAt"],
            ]),
            ...(system
              ? [
                  {
                    kind: "text" as const,
                    variant: "muted" as const,
                    content: "WorkOS manages system permissions; they cannot be deleted.",
                  },
                ]
              : []),
          ],
        },
      ],
      headerActions: [{ kind: "action", label: "Refresh", action: { type: "refresh-resource" } }],
    };
  }

  private renderApiKeyDetail(resource: ResourceInstance): DetailViewSchema {
    const status = this.apiKeyStatus(resource);
    return {
      title: resource.displayName,
      subtitle: "Organization API key",
      status: {
        kind: "status-dot",
        status,
        label: status === "error" ? "Expired" : "Active",
      },
      sections: [
        {
          kind: "section",
          title: "API Key",
          children: [
            this.kv(resource, [
              ["Name", "name"],
              ["Key", "obfuscatedValue"],
              ["Permissions", "permissions"],
              ["Last used", "lastUsedAt"],
              ["Expires", "expiresAt"],
              ["Organization ID", "organizationId"],
              ["Created", "createdAt"],
            ]),
            {
              kind: "text",
              variant: "muted",
              content:
                "The full key is only returned when it is created; it is kept as the sensitive apiKey output of keys created here.",
            },
          ],
        },
      ],
      headerActions: [
        { kind: "action", label: "Refresh", action: { type: "refresh-resource" } },
        ...(status !== "error"
          ? [
              {
                kind: "action" as const,
                label: "Expire now",
                variant: "danger" as const,
                action: {
                  type: "plugin-action" as const,
                  actionId: "expire",
                  confirmMessage:
                    "Expire this API key now? Requests using it start failing immediately.",
                  successMessage: "API key expired.",
                },
              },
            ]
          : []),
      ],
    };
  }

  private renderFeatureFlagDetail(resource: ResourceInstance): DetailViewSchema {
    const enabled = resource.fields["enabled"] === true;
    const targets = this.stashed<Array<{ id: string; label: string }>>(resource, "__targets__", []);
    const targetField = {
      key: "target",
      label: "Organization or user",
      kind: "select" as const,
      required: true,
      options: targets,
      ...(targets[0] ? { defaultValue: targets[0].id } : {}),
    };
    return {
      title: resource.displayName,
      subtitle: `Feature flag · ${String(resource.fields["slug"] ?? "")}`,
      status: {
        kind: "status-dot",
        status: enabled ? "healthy" : "degraded",
        label: enabled ? "Enabled" : "Disabled",
      },
      sections: [
        {
          kind: "section",
          title: "Flag",
          children: [
            this.kv(resource, [
              ["Slug", "slug"],
              ["Name", "name"],
              ["Description", "description"],
              ["Enabled", "enabled"],
              ["Default value", "defaultValue"],
              ["Tags", "tags"],
              ["Owner", "owner"],
              ["Created", "createdAt"],
            ]),
          ],
        },
      ],
      headerActions: [
        { kind: "action", label: "Refresh", action: { type: "refresh-resource" } },
        {
          kind: "action",
          label: enabled ? "Disable" : "Enable",
          ...(enabled ? { variant: "danger" as const } : {}),
          action: {
            type: "plugin-action",
            actionId: enabled ? "disable" : "enable",
            confirmMessage: enabled
              ? "Disable this flag? Everyone falls back to its default value."
              : "Enable this flag in this environment?",
            successMessage: enabled ? "Flag disabled." : "Flag enabled.",
          },
        },
        ...(targets.length > 0
          ? [
              {
                kind: "action" as const,
                label: "Add target…",
                action: {
                  type: "prompt-nosql-command" as const,
                  command: "add-target",
                  title: "Target an organization or user",
                  fields: [targetField],
                  submitLabel: "Add target",
                },
              },
              {
                kind: "action" as const,
                label: "Remove target…",
                action: {
                  type: "prompt-nosql-command" as const,
                  command: "remove-target",
                  title: "Stop targeting an organization or user",
                  fields: [targetField],
                  submitLabel: "Remove target",
                  danger: true,
                },
              },
            ]
          : []),
      ],
    };
  }

  private renderGroupDetail(resource: ResourceInstance): DetailViewSchema {
    const members = this.stashed<Array<{ id: string; label: string; status: string }>>(
      resource,
      "__members__",
      [],
    );
    const candidates = this.stashed<Array<{ id: string; label: string }>>(
      resource,
      "__candidates__",
      [],
    );
    const headerActions: DetailViewSchema["headerActions"] = [
      { kind: "action", label: "Refresh", action: { type: "refresh-resource" } },
    ];
    if (candidates.length > 0) {
      headerActions.push({
        kind: "action",
        label: "Add member…",
        action: {
          type: "prompt-nosql-command",
          command: "add-member",
          title: "Add a member to this group",
          fields: [
            {
              key: "membershipId",
              label: "Member",
              kind: "select",
              required: true,
              options: candidates,
              defaultValue: candidates[0]!.id,
            },
          ],
          submitLabel: "Add",
        },
      });
    }
    if (members.length > 0) {
      headerActions.push({
        kind: "action",
        label: "Remove member…",
        variant: "danger",
        action: {
          type: "prompt-nosql-command",
          command: "remove-member",
          title: "Remove a member from this group",
          fields: [
            {
              key: "membershipId",
              label: "Member",
              kind: "select",
              required: true,
              options: members.map(({ id, label }) => ({ id, label })),
              defaultValue: members[0]!.id,
            },
          ],
          submitLabel: "Remove",
          danger: true,
        },
      });
    }
    return {
      title: resource.displayName,
      subtitle: "WorkOS group",
      status: { kind: "status-dot", status: "info" },
      sections: [
        {
          kind: "section",
          title: "Group",
          children: [
            this.kv(resource, [
              ["Name", "name"],
              ["Description", "description"],
              ["Organization ID", "organizationId"],
              ["Created", "createdAt"],
            ]),
          ],
        },
        {
          kind: "section",
          title: `Members (${members.length})`,
          children: [
            members.length > 0
              ? {
                  kind: "table",
                  columns: [
                    { key: "member", label: "Member" },
                    { key: "status", label: "Status", width: "narrow" },
                  ],
                  rows: members.map((m) => ({ cells: { member: m.label, status: m.status } })),
                }
              : { kind: "text", variant: "muted", content: "No members yet." },
          ],
        },
      ],
      headerActions,
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
              "The signing secret is available as the sensitive `signingSecret` output, for verifying webhook payload signatures.",
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
