/**
 * Enterprise single sign-on routes (`/api/org/:orgId/sso/*`).
 *
 * Reading is `team:read` (who can sign in how is part of the team picture).
 * Every change is `org:settings:write`, the owner-only permission the catalog
 * already reserves for SSO, and the paid plan: an org on the free plan has one
 * user and nothing to federate.
 *
 * Mapping a group to a role is additionally held to the rule the team page
 * applies to assigning a role: the caller must hold every permission the role
 * grants, and the owner role is never a target. A group mapping is a standing
 * role assignment to whoever the IdP admin puts in the group, so it cannot be
 * a way to hand out more than the person creating it could hand out directly.
 */
import { Hono, type Context } from "hono";
import { and, asc, eq, sql } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import { z } from "zod";
import {
  isSubsetOfCallerPerms,
  isSystemRoleKey,
  systemRolePermissions,
} from "@infrawrench/server-core/permissions";
import { appPath } from "@infrawrench/server-core/app-url";
import { SSO_PORTAL_INTENTS, type SsoStatus } from "@infrawrench/client-core";
import { db } from "../../db/client";
import {
  orgSsoSettings,
  organizationMembers,
  organizations,
  roles,
  ssoDirectoryMembers,
  ssoGroupRoleMappings,
  users,
} from "../../db/schema";
import { requirePermission } from "../../auth/permissions";
import { logAudit } from "../../services/audit";
import { planAccess } from "../../services/entitlements";
import { isOwnerRole } from "../../services/org-roles";
import {
  loadMappings,
  previewMappings,
  reconcileDirectories,
} from "../../services/sso/directory-sync";
import { currentSessionState } from "../../services/sso/enforcement";
import { normalizeDomain, type GroupRoleMapping } from "../../services/sso/group-roles";
import {
  loadSsoSettings,
  updateSsoSettings,
  type SsoSettingsRow,
} from "../../services/sso/settings";
import * as wos from "../../services/sso/workos-api";
import type { AuthSession } from "../auth-middleware";

declare module "hono" {
  interface ContextVariableMap {
    session: AuthSession;
    organizationId: string;
  }
}

const app = new Hono();

/** At most this many break-glass owners: enough for redundancy, few enough to audit. */
const MAX_BREAK_GLASS = 5;

function serializeSettings(row: SsoSettingsRow) {
  return {
    enforceSso: row.enforceSso,
    breakGlassUserIds: row.breakGlassUserIds,
    provisioningEnabled: row.provisioningEnabled,
    defaultRoleId: row.defaultRoleId,
    autoAddSeats: row.autoAddSeats,
    updatedAt: row.updatedAt.toISOString(),
  };
}

function workosFailure(c: Context, err: unknown, what: string) {
  const status = (err as { status?: number }).status;
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[sso] ${what} failed:`, err);
  if (status === 400 || status === 422 || status === 409) {
    return c.json({ error: `WorkOS rejected this: ${message}` }, 400);
  }
  if (status === 404) return c.json({ error: "Not found in WorkOS" }, 404);
  return c.json({ error: `Could not reach WorkOS to ${what}` }, 502);
}

async function requirePlan(c: Context): Promise<Response | null> {
  const access = await planAccess(c.get("organizationId"));
  if (access.paid) return null;
  return c.json(
    {
      error:
        access.reason === "inactive"
          ? `Single sign-on needs an active plan; this organization's subscription is ${access.status}. Reactivate it under Settings → Billing.`
          : "Single sign-on is available on the paid plan. Upgrade under Settings → Billing.",
    },
    402,
  );
}

async function requireSettings(c: Context): Promise<SsoSettingsRow | Response> {
  const row = await loadSsoSettings(c.get("organizationId"));
  if (!row)
    return c.json({ error: "Single sign-on has not been set up for this organization" }, 409);
  return row;
}

async function listOwners(organizationId: string) {
  const rows = await db
    .select({
      userId: organizationMembers.userId,
      legacyRole: organizationMembers.role,
      systemKey: roles.systemKey,
      email: users.email,
      displayName: users.displayName,
    })
    .from(organizationMembers)
    .innerJoin(users, eq(users.id, organizationMembers.userId))
    .leftJoin(roles, eq(organizationMembers.roleId, roles.id))
    .where(eq(organizationMembers.organizationId, organizationId));
  return rows
    .filter((r) => isOwnerRole(r.systemKey, r.legacyRole))
    .map((r) => ({ userId: r.userId, email: r.email, displayName: r.displayName }));
}

/** A role row in this org, with its effective permissions. */
async function roleForMapping(organizationId: string, roleId: string) {
  const [r] = await db
    .select()
    .from(roles)
    .where(and(eq(roles.id, roleId), eq(roles.organizationId, organizationId)))
    .limit(1);
  if (!r) return null;
  const permissions =
    r.isSystem && isSystemRoleKey(r.systemKey)
      ? (systemRolePermissions(r.systemKey) ?? [])
      : ((r.permissions as string[]) ?? []);
  return { id: r.id, name: r.name, systemKey: r.systemKey, permissions };
}

/** Validate a role as a mapping or default target for this caller; an error message or null. */
async function roleTargetError(c: Context, roleId: string): Promise<string | null> {
  const role = await roleForMapping(c.get("organizationId"), roleId);
  if (!role) return "Role not found";
  if (role.systemKey === "owner") {
    return "Group mappings cannot grant the owner role. Owners are appointed on the Team page.";
  }
  if (!isSubsetOfCallerPerms(role.permissions, c.get("permissions") ?? [])) {
    return "Cannot map a group to a role with permissions you do not hold";
  }
  return null;
}

/** Every group across the org's directories, for the picker and for validating a mapping. */
async function directoryGroups(workosOrgId: string) {
  const directories = await wos.listDirectories(workosOrgId);
  const out: Array<{ id: string; name: string; directoryId: string; directoryName: string }> = [];
  for (const d of directories) {
    const groups = await wos.listDirectoryGroups(d.id);
    for (const g of groups) {
      out.push({ id: g.id, name: g.name, directoryId: d.id, directoryName: d.name });
    }
  }
  return out;
}

function serializeMapping(
  m: typeof ssoGroupRoleMappings.$inferSelect,
  roleNames: Map<string, string>,
) {
  return {
    id: m.id,
    directoryGroupId: m.directoryGroupId,
    groupName: m.groupName,
    roleId: m.roleId,
    roleName: roleNames.get(m.roleId) ?? null,
    position: m.position,
    createdAt: m.createdAt.toISOString(),
    updatedAt: m.updatedAt.toISOString(),
  };
}

async function roleNameMap(organizationId: string): Promise<Map<string, string>> {
  const rows = await db
    .select({ id: roles.id, name: roles.name })
    .from(roles)
    .where(eq(roles.organizationId, organizationId));
  return new Map(rows.map((r) => [r.id, r.name]));
}

// --- Status --------------------------------------------------------------

/** GET /sso: everything the Single sign-on page renders, in one read. */
app.get("/", async (c) => {
  requirePermission(c, "team:read");
  const organizationId = c.get("organizationId");
  const session = c.get("session");
  const access = await planAccess(organizationId);
  const owners = await listOwners(organizationId);
  let settings = await loadSsoSettings(organizationId);

  const status: SsoStatus = {
    planIncluded: access.paid,
    configured: !!settings,
    settings: settings ? serializeSettings(settings) : null,
    domains: [],
    connections: [],
    directories: [],
    workosError: null,
    owners,
    currentSession: "unknown",
    directoryMemberCounts: {},
  };
  if (!settings) return c.json(status);

  try {
    const [domains, connections, directories] = await Promise.all([
      wos.listDomains(settings.workosOrganizationId),
      wos.listConnections(settings.workosOrganizationId),
      wos.listDirectories(settings.workosOrganizationId),
    ]);
    status.domains = domains;
    status.connections = connections;
    status.directories = directories;
    // Keep the enforcement gate's snapshot in step with what WorkOS says.
    const verified = domains
      .filter((d) => d.state === "verified")
      .map((d) => d.domain)
      .sort();
    if (verified.join(",") !== [...settings.verifiedDomains].sort().join(",")) {
      settings =
        (await updateSsoSettings(organizationId, { verifiedDomains: verified })) ?? settings;
      status.settings = serializeSettings(settings);
    }
  } catch (err) {
    console.error("[sso] status read from WorkOS failed:", err);
    status.workosError = "Could not reach WorkOS; showing saved settings only.";
  }

  status.currentSession = await currentSessionState({
    settings,
    userId: session.userId,
    email: session.email,
    sessionId: session.sessionId,
  });

  const counts = await db
    .select({ status: ssoDirectoryMembers.status, n: sql<number>`count(*)` })
    .from(ssoDirectoryMembers)
    .where(eq(ssoDirectoryMembers.organizationId, organizationId))
    .groupBy(ssoDirectoryMembers.status);
  status.directoryMemberCounts = Object.fromEntries(counts.map((r) => [r.status, Number(r.n)]));
  return c.json(status);
});

// --- Setup ---------------------------------------------------------------

/** POST /sso/setup: create the WorkOS organization. Idempotent. */
app.post("/setup", async (c) => {
  requirePermission(c, "org:settings:write");
  const planDenied = await requirePlan(c);
  if (planDenied) return planDenied;
  const organizationId = c.get("organizationId");
  const existing = await loadSsoSettings(organizationId);
  if (existing) return c.json({ ok: true, created: false });

  const [org] = await db
    .select({ displayName: organizations.displayName })
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .limit(1);
  let workosOrganizationId: string;
  try {
    workosOrganizationId = await wos.createWorkosOrganization(
      org?.displayName ?? organizationId,
      organizationId,
    );
  } catch (err) {
    return workosFailure(c, err, "create the WorkOS organization");
  }
  await db
    .insert(orgSsoSettings)
    .values({ organizationId, workosOrganizationId, updatedByUserId: c.get("session").userId })
    .onConflictDoNothing();
  void logAudit({
    organizationId,
    userId: c.get("session").userId,
    action: "sso.setup",
    entityType: "sso",
    entityId: organizationId,
    metadata: { workosOrganizationId },
  });
  return c.json({ ok: true, created: true });
});

const portalBody = z.object({ intent: z.enum(SSO_PORTAL_INTENTS) });

/**
 * POST /sso/portal-link: a five-minute WorkOS Admin Portal link for the
 * customer's IT admin. Never stored; minting one is audit-logged because it
 * is a credential to change how the whole org signs in.
 */
app.post("/portal-link", async (c) => {
  requirePermission(c, "org:settings:write");
  const planDenied = await requirePlan(c);
  if (planDenied) return planDenied;
  const parsed = portalBody.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success)
    return c.json({ error: "intent must be sso, dsync or domain_verification" }, 400);
  const settings = await requireSettings(c);
  if (settings instanceof Response) return settings;
  const organizationId = c.get("organizationId");
  const returnUrl =
    appPath(`/org/${organizationId}/settings/sso`) ??
    `${new URL(c.req.url).origin}/org/${organizationId}/settings/sso`;
  let link: string;
  try {
    link = await wos.generatePortalLink(
      settings.workosOrganizationId,
      parsed.data.intent,
      returnUrl,
    );
  } catch (err) {
    return workosFailure(c, err, "open the Admin Portal");
  }
  void logAudit({
    organizationId,
    userId: c.get("session").userId,
    action: "sso.portal_link",
    entityType: "sso",
    entityId: organizationId,
    metadata: { intent: parsed.data.intent },
  });
  return c.json({ link });
});

// --- Domains -------------------------------------------------------------

const domainBody = z.object({ domain: z.string().min(3).max(253) });

app.post("/domains", async (c) => {
  requirePermission(c, "org:settings:write");
  const planDenied = await requirePlan(c);
  if (planDenied) return planDenied;
  const parsed = domainBody.safeParse(await c.req.json().catch(() => ({})));
  const domain = parsed.success ? normalizeDomain(parsed.data.domain) : null;
  if (!domain) return c.json({ error: "Enter a domain like example.com" }, 400);
  const settings = await requireSettings(c);
  if (settings instanceof Response) return settings;
  try {
    const created = await wos.createDomain(settings.workosOrganizationId, domain);
    void logAudit({
      organizationId: c.get("organizationId"),
      userId: c.get("session").userId,
      action: "sso.domain_add",
      entityType: "sso",
      entityId: created.id,
      metadata: { domain },
    });
    return c.json(created);
  } catch (err) {
    return workosFailure(c, err, "add the domain");
  }
});

/** Look a domain up and confirm it belongs to this org's WorkOS organization. */
async function ownedDomain(settings: SsoSettingsRow, id: string) {
  const domains = await wos.listDomains(settings.workosOrganizationId);
  return domains.find((d) => d.id === id) ?? null;
}

async function refreshVerified(settings: SsoSettingsRow) {
  const domains = await wos.listDomains(settings.workosOrganizationId);
  await updateSsoSettings(settings.organizationId, {
    verifiedDomains: domains.filter((d) => d.state === "verified").map((d) => d.domain),
  });
}

app.post("/domains/:id/verify", async (c) => {
  requirePermission(c, "org:settings:write");
  const settings = await requireSettings(c);
  if (settings instanceof Response) return settings;
  try {
    const owned = await ownedDomain(settings, c.req.param("id"));
    if (!owned) return c.json({ error: "Domain not found" }, 404);
    const result = await wos.verifyDomain(owned.id);
    await refreshVerified(settings);
    if (result.state === "verified") {
      void logAudit({
        organizationId: c.get("organizationId"),
        userId: c.get("session").userId,
        action: "sso.domain_verify",
        entityType: "sso",
        entityId: owned.id,
        metadata: { domain: owned.domain },
      });
    }
    return c.json(result);
  } catch (err) {
    return workosFailure(c, err, "verify the domain");
  }
});

app.delete("/domains/:id", async (c) => {
  requirePermission(c, "org:settings:write");
  const settings = await requireSettings(c);
  if (settings instanceof Response) return settings;
  try {
    const owned = await ownedDomain(settings, c.req.param("id"));
    if (!owned) return c.json({ error: "Domain not found" }, 404);
    await wos.deleteDomain(owned.id);
    await refreshVerified(settings);
    void logAudit({
      organizationId: c.get("organizationId"),
      userId: c.get("session").userId,
      action: "sso.domain_remove",
      entityType: "sso",
      entityId: owned.id,
      metadata: { domain: owned.domain },
    });
    return c.json({ ok: true });
  } catch (err) {
    return workosFailure(c, err, "remove the domain");
  }
});

// --- Settings ------------------------------------------------------------

const settingsBody = z.object({
  enforceSso: z.boolean().optional(),
  breakGlassUserIds: z.array(z.string().min(1).max(128)).max(MAX_BREAK_GLASS).optional(),
  provisioningEnabled: z.boolean().optional(),
  defaultRoleId: z.string().min(1).max(128).nullable().optional(),
  autoAddSeats: z.boolean().optional(),
});

/**
 * PUT /sso/settings. Turning enforcement on is where an org can lock itself
 * out, so it is refused unless every way back in exists first: a verified
 * domain (or there is nothing to enforce), an active connection (or nobody
 * can satisfy it), at least one break-glass owner, and the caller's own
 * session already passing (they are signed in with SSO, are a break-glass
 * owner, or sit outside the enforced domains).
 */
app.put("/settings", async (c) => {
  requirePermission(c, "org:settings:write");
  const planDenied = await requirePlan(c);
  if (planDenied) return planDenied;
  const parsed = settingsBody.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success)
    return c.json({ error: parsed.error.issues[0]?.message ?? "Invalid body" }, 400);
  const body = parsed.data;
  const settings = await requireSettings(c);
  if (settings instanceof Response) return settings;
  const organizationId = c.get("organizationId");
  const session = c.get("session");

  if (body.breakGlassUserIds) {
    const ownerIds = new Set((await listOwners(organizationId)).map((o) => o.userId));
    const unique = [...new Set(body.breakGlassUserIds)];
    const notOwner = unique.find((id) => !ownerIds.has(id));
    if (notOwner) return c.json({ error: "Only owners can be break-glass accounts" }, 400);
    body.breakGlassUserIds = unique;
  }
  if (body.defaultRoleId) {
    const err = await roleTargetError(c, body.defaultRoleId);
    if (err) return c.json({ error: err }, err === "Role not found" ? 404 : 403);
  }
  if (body.autoAddSeats === true && !settings.autoAddSeats) {
    // Buying seats is a billing change, not a settings change.
    requirePermission(c, "billing:write");
  }

  const next = { ...settings, ...body } as SsoSettingsRow;
  if (body.enforceSso === true || (next.enforceSso && body.breakGlassUserIds)) {
    let domains: wos.WorkosDomain[];
    let connections: wos.WorkosConnection[];
    try {
      [domains, connections] = await Promise.all([
        wos.listDomains(settings.workosOrganizationId),
        wos.listConnections(settings.workosOrganizationId),
      ]);
    } catch (err) {
      return workosFailure(c, err, "check the SSO setup");
    }
    const verified = domains.filter((d) => d.state === "verified").map((d) => d.domain);
    next.verifiedDomains = verified;
    if (verified.length === 0) {
      return c.json({ error: "Verify at least one domain before requiring SSO" }, 400);
    }
    if (!connections.some((x) => x.state === "active")) {
      return c.json({ error: "Connect an identity provider before requiring SSO" }, 400);
    }
    if (next.breakGlassUserIds.length === 0) {
      return c.json(
        {
          error:
            "Choose at least one break-glass owner before requiring SSO, so the organization can still be reached if the identity provider is down",
        },
        400,
      );
    }
    const state = await currentSessionState({
      settings: next,
      userId: session.userId,
      email: session.email,
      sessionId: session.sessionId,
    });
    if (state === "not_sso" || state === "unknown") {
      return c.json(
        {
          error:
            "Sign in through your identity provider (or add yourself as a break-glass owner) before requiring SSO, or this change would sign you out of the organization",
        },
        400,
      );
    }
  }

  const updated = await updateSsoSettings(organizationId, {
    ...(body.enforceSso !== undefined ? { enforceSso: body.enforceSso } : {}),
    ...(body.breakGlassUserIds ? { breakGlassUserIds: body.breakGlassUserIds } : {}),
    ...(body.provisioningEnabled !== undefined
      ? { provisioningEnabled: body.provisioningEnabled }
      : {}),
    ...(body.defaultRoleId !== undefined ? { defaultRoleId: body.defaultRoleId } : {}),
    ...(body.autoAddSeats !== undefined ? { autoAddSeats: body.autoAddSeats } : {}),
    verifiedDomains: next.verifiedDomains,
    updatedByUserId: session.userId,
  });
  void logAudit({
    organizationId,
    userId: session.userId,
    action: "sso.settings_update",
    entityType: "sso",
    entityId: organizationId,
    metadata: {
      changes: body,
      previous: {
        enforceSso: settings.enforceSso,
        breakGlassUserIds: settings.breakGlassUserIds,
        provisioningEnabled: settings.provisioningEnabled,
        defaultRoleId: settings.defaultRoleId,
        autoAddSeats: settings.autoAddSeats,
      },
    },
  });
  return c.json(serializeSettings(updated ?? next));
});

// --- Directory -----------------------------------------------------------

/** GET /sso/groups: directory groups for the mapping picker. */
app.get("/groups", async (c) => {
  requirePermission(c, "team:read");
  const settings = await requireSettings(c);
  if (settings instanceof Response) return settings;
  try {
    return c.json({ groups: await directoryGroups(settings.workosOrganizationId) });
  } catch (err) {
    return workosFailure(c, err, "list directory groups");
  }
});

/** GET /sso/directory-members: every directory user seen, and what became of them. */
app.get("/directory-members", async (c) => {
  requirePermission(c, "team:read");
  const rows = await db
    .select()
    .from(ssoDirectoryMembers)
    .where(eq(ssoDirectoryMembers.organizationId, c.get("organizationId")))
    .orderBy(asc(ssoDirectoryMembers.email));
  return c.json({
    members: rows.map((r) => ({
      id: r.id,
      directoryId: r.directoryId,
      directoryUserId: r.directoryUserId,
      email: r.email,
      displayName: r.displayName,
      userId: r.userId,
      groupIds: r.groupIds,
      status: r.status,
      provisionedByDirectory: r.provisionedByDirectory,
      lastSyncedAt: r.lastSyncedAt.toISOString(),
      deprovisionedAt: r.deprovisionedAt?.toISOString() ?? null,
    })),
  });
});

/** POST /sso/sync: reconcile every directory user now. */
app.post("/sync", async (c) => {
  requirePermission(c, "org:settings:write");
  const planDenied = await requirePlan(c);
  if (planDenied) return planDenied;
  const settings = await requireSettings(c);
  if (settings instanceof Response) return settings;
  try {
    const result = await reconcileDirectories(settings);
    void logAudit({
      organizationId: c.get("organizationId"),
      userId: c.get("session").userId,
      action: "sso.sync",
      entityType: "sso",
      entityId: c.get("organizationId"),
      metadata: { ...result },
    });
    return c.json(result);
  } catch (err) {
    return workosFailure(c, err, "sync the directory");
  }
});

// --- Group → role mappings -----------------------------------------------

app.get("/group-mappings", async (c) => {
  requirePermission(c, "team:read");
  const organizationId = c.get("organizationId");
  const [rows, names] = await Promise.all([
    db
      .select()
      .from(ssoGroupRoleMappings)
      .where(eq(ssoGroupRoleMappings.organizationId, organizationId)),
    roleNameMap(organizationId),
  ]);
  const ordered = [...rows].sort(
    (a, b) => a.position - b.position || a.createdAt.getTime() - b.createdAt.getTime(),
  );
  return c.json({ mappings: ordered.map((m) => serializeMapping(m, names)) });
});

app.get("/group-mappings/:id", async (c) => {
  requirePermission(c, "team:read");
  const organizationId = c.get("organizationId");
  const [row] = await db
    .select()
    .from(ssoGroupRoleMappings)
    .where(
      and(
        eq(ssoGroupRoleMappings.id, c.req.param("id")),
        eq(ssoGroupRoleMappings.organizationId, organizationId),
      ),
    )
    .limit(1);
  if (!row) return c.json({ error: "Mapping not found" }, 404);
  return c.json(serializeMapping(row, await roleNameMap(organizationId)));
});

const createMappingBody = z.object({
  directoryGroupId: z.string().min(1).max(128),
  roleId: z.string().min(1).max(128),
  position: z.number().int().min(0).max(10_000).optional(),
});

app.post("/group-mappings", async (c) => {
  requirePermission(c, "org:settings:write");
  const planDenied = await requirePlan(c);
  if (planDenied) return planDenied;
  const parsed = createMappingBody.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: "directoryGroupId and roleId are required" }, 400);
  const settings = await requireSettings(c);
  if (settings instanceof Response) return settings;
  const organizationId = c.get("organizationId");
  const roleErr = await roleTargetError(c, parsed.data.roleId);
  if (roleErr) return c.json({ error: roleErr }, roleErr === "Role not found" ? 404 : 403);

  let group: { id: string; name: string } | undefined;
  try {
    group = (await directoryGroups(settings.workosOrganizationId)).find(
      (g) => g.id === parsed.data.directoryGroupId,
    );
  } catch (err) {
    return workosFailure(c, err, "look up the directory group");
  }
  if (!group)
    return c.json({ error: "That group is not in any of this organization's directories" }, 404);

  const existing = await loadMappings(organizationId);
  if (existing.some((m) => m.directoryGroupId === group.id)) {
    return c.json({ error: "That group is already mapped; edit the existing mapping" }, 409);
  }
  const position =
    parsed.data.position ?? existing.reduce((max, m) => Math.max(max, m.position + 1), 0);
  const id = uuid();
  const [row] = await db
    .insert(ssoGroupRoleMappings)
    .values({
      id,
      organizationId,
      directoryGroupId: group.id,
      groupName: group.name,
      roleId: parsed.data.roleId,
      position,
    })
    .returning();
  void logAudit({
    organizationId,
    userId: c.get("session").userId,
    action: "sso.mapping_create",
    entityType: "sso",
    entityId: id,
    metadata: {
      directoryGroupId: group.id,
      groupName: group.name,
      roleId: parsed.data.roleId,
      position,
    },
  });
  return c.json(serializeMapping(row!, await roleNameMap(organizationId)), 201);
});

const updateMappingBody = z.object({
  roleId: z.string().min(1).max(128).optional(),
  position: z.number().int().min(0).max(10_000).optional(),
});

app.patch("/group-mappings/:id", async (c) => {
  requirePermission(c, "org:settings:write");
  const planDenied = await requirePlan(c);
  if (planDenied) return planDenied;
  const parsed = updateMappingBody.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: "Invalid body" }, 400);
  const organizationId = c.get("organizationId");
  const id = c.req.param("id");
  if (parsed.data.roleId) {
    const roleErr = await roleTargetError(c, parsed.data.roleId);
    if (roleErr) return c.json({ error: roleErr }, roleErr === "Role not found" ? 404 : 403);
  }
  const [prior] = await db
    .select()
    .from(ssoGroupRoleMappings)
    .where(
      and(eq(ssoGroupRoleMappings.id, id), eq(ssoGroupRoleMappings.organizationId, organizationId)),
    )
    .limit(1);
  if (!prior) return c.json({ error: "Mapping not found" }, 404);
  // Re-pointing a mapping the caller could not have created is as much an
  // escalation as creating it: the current role must be within reach too.
  const priorErr = await roleTargetError(c, prior.roleId);
  if (priorErr && priorErr !== "Role not found") return c.json({ error: priorErr }, 403);
  const [row] = await db
    .update(ssoGroupRoleMappings)
    .set({
      ...(parsed.data.roleId ? { roleId: parsed.data.roleId } : {}),
      ...(parsed.data.position !== undefined ? { position: parsed.data.position } : {}),
      updatedAt: new Date(),
    })
    .where(eq(ssoGroupRoleMappings.id, id))
    .returning();
  void logAudit({
    organizationId,
    userId: c.get("session").userId,
    action: "sso.mapping_update",
    entityType: "sso",
    entityId: id,
    metadata: {
      groupName: prior.groupName,
      from: { roleId: prior.roleId, position: prior.position },
      to: parsed.data,
    },
  });
  return c.json(serializeMapping(row!, await roleNameMap(organizationId)));
});

app.delete("/group-mappings/:id", async (c) => {
  requirePermission(c, "org:settings:write");
  const organizationId = c.get("organizationId");
  const id = c.req.param("id");
  const [prior] = await db
    .select()
    .from(ssoGroupRoleMappings)
    .where(
      and(eq(ssoGroupRoleMappings.id, id), eq(ssoGroupRoleMappings.organizationId, organizationId)),
    )
    .limit(1);
  if (!prior) return c.json({ error: "Mapping not found" }, 404);
  const priorErr = await roleTargetError(c, prior.roleId);
  if (priorErr && priorErr !== "Role not found") return c.json({ error: priorErr }, 403);
  await db.delete(ssoGroupRoleMappings).where(eq(ssoGroupRoleMappings.id, id));
  void logAudit({
    organizationId,
    userId: c.get("session").userId,
    action: "sso.mapping_delete",
    entityType: "sso",
    entityId: id,
    metadata: { groupName: prior.groupName, roleId: prior.roleId },
  });
  return c.json({ ok: true });
});

const previewBody = z.object({
  mappings: z
    .array(
      z.object({
        directoryGroupId: z.string().min(1).max(128),
        groupName: z.string().max(256).optional(),
        roleId: z.string().min(1).max(128),
        position: z.number().int().min(0).max(10_000),
      }),
    )
    .max(500)
    .optional(),
  defaultRoleId: z.string().min(1).max(128).nullable().optional(),
});

/**
 * POST /sso/group-mappings/preview: what the mappings (saved, or the unsaved
 * set in the body) would do to every directory member. Changes nothing.
 */
app.post("/group-mappings/preview", async (c) => {
  requirePermission(c, "team:read");
  const parsed = previewBody.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: "Invalid body" }, 400);
  const settings = await requireSettings(c);
  if (settings instanceof Response) return settings;
  const mappings: GroupRoleMapping[] = parsed.data.mappings
    ? parsed.data.mappings.map((m, i) => ({
        id: `preview-${i}`,
        directoryGroupId: m.directoryGroupId,
        groupName: m.groupName ?? m.directoryGroupId,
        roleId: m.roleId,
        position: m.position,
      }))
    : await loadMappings(c.get("organizationId"));
  const defaultRoleId =
    parsed.data.defaultRoleId !== undefined ? parsed.data.defaultRoleId : settings.defaultRoleId;
  return c.json({ rows: await previewMappings(settings, mappings, defaultRoleId) });
});

export { app as ssoRoutes };
