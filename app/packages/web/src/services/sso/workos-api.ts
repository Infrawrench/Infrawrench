/**
 * Every WorkOS call enterprise SSO makes, behind one seam.
 *
 * The rest of `services/sso/` and the routes import from here rather than
 * from the SDK, so tests can mock one module, and so the shape we depend on is
 * written down in one place: these are the WorkOS Organizations, Organization
 * Domains, SSO, Directory Sync, Admin Portal and User Management APIs.
 */
import { GeneratePortalLinkIntent } from "@workos-inc/node";
import { workos } from "../../auth/workos";

export type PortalIntent = "sso" | "dsync" | "domain_verification";

const PORTAL_INTENTS: Record<PortalIntent, GeneratePortalLinkIntent> = {
  sso: GeneratePortalLinkIntent.SSO,
  dsync: GeneratePortalLinkIntent.DSync,
  domain_verification: GeneratePortalLinkIntent.DomainVerification,
};

export interface WorkosDomain {
  id: string;
  domain: string;
  state: "verified" | "pending" | "failed" | string;
  verificationStrategy: string;
  /** `_workos-challenge` style record name to create, when DNS verification is pending. */
  verificationPrefix: string | null;
  verificationToken: string | null;
}

export interface WorkosConnection {
  id: string;
  name: string;
  type: string;
  state: "draft" | "active" | "inactive" | "validating" | string;
}

export interface WorkosDirectory {
  id: string;
  name: string;
  type: string;
  state: string;
}

export interface WorkosDirectoryGroup {
  id: string;
  name: string;
  directoryId: string;
}

export interface WorkosDirectoryUser {
  id: string;
  directoryId: string;
  organizationId: string | null;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  state: "active" | "inactive" | string;
  groups: WorkosDirectoryGroup[];
}

export interface WorkosSessionAuth {
  authMethod: string;
  organizationId: string | null;
  status: string;
}

function toDomain(d: {
  id: string;
  domain: string;
  state: string;
  verificationStrategy: string;
  verificationPrefix?: string;
  verificationToken?: string;
}): WorkosDomain {
  return {
    id: d.id,
    domain: d.domain.toLowerCase(),
    state: d.state,
    verificationStrategy: d.verificationStrategy,
    verificationPrefix: d.verificationPrefix ?? null,
    verificationToken: d.verificationToken ?? null,
  };
}

/**
 * Create the WorkOS organization an Infrawrench org's SSO hangs off.
 * `externalId` is the Infrawrench org id, so the link can be recovered from
 * the WorkOS side if our row is ever lost, and the idempotency key makes a
 * double-click create one organization rather than two.
 */
export async function createWorkosOrganization(
  name: string,
  infrawrenchOrgId: string,
): Promise<string> {
  try {
    const existing = await workos.organizations.getOrganizationByExternalId(infrawrenchOrgId);
    if (existing?.id) return existing.id;
  } catch {
    // Not found is the normal first-time answer.
  }
  const org = await workos.organizations.createOrganization(
    { name, externalId: infrawrenchOrgId },
    { idempotencyKey: `infrawrench-sso-${infrawrenchOrgId}` },
  );
  return org.id;
}

export async function listDomains(workosOrgId: string): Promise<WorkosDomain[]> {
  const org = await workos.organizations.getOrganization(workosOrgId);
  return org.domains.map(toDomain);
}

export async function createDomain(workosOrgId: string, domain: string): Promise<WorkosDomain> {
  const created = await workos.organizationDomains.create({
    domain,
    organizationId: workosOrgId,
  });
  return toDomain(created);
}

export async function getDomain(id: string): Promise<WorkosDomain> {
  return toDomain(await workos.organizationDomains.get(id));
}

export async function verifyDomain(id: string): Promise<WorkosDomain> {
  return toDomain(await workos.organizationDomains.verify(id));
}

export async function deleteDomain(id: string): Promise<void> {
  await workos.organizationDomains.delete(id);
}

export async function listConnections(workosOrgId: string): Promise<WorkosConnection[]> {
  const page = await workos.sso.listConnections({ organizationId: workosOrgId, limit: 100 });
  const all = await page.autoPagination();
  return all.map((c) => ({ id: c.id, name: c.name, type: String(c.type), state: c.state }));
}

export async function listDirectories(workosOrgId: string): Promise<WorkosDirectory[]> {
  const page = await workos.directorySync.listDirectories({
    organizationId: workosOrgId,
    limit: 100,
  });
  const all = await page.autoPagination();
  return all.map((d) => ({ id: d.id, name: d.name, type: String(d.type), state: d.state }));
}

/** The WorkOS organization a directory belongs to, or null. */
export async function directoryOrganizationId(directoryId: string): Promise<string | null> {
  const d = await workos.directorySync.getDirectory(directoryId);
  return d.organizationId ?? null;
}

export async function listDirectoryGroups(directoryId: string): Promise<WorkosDirectoryGroup[]> {
  const page = await workos.directorySync.listGroups({ directory: directoryId, limit: 100 });
  const all = await page.autoPagination();
  return all.map((g) => ({ id: g.id, name: g.name, directoryId: g.directoryId }));
}

function toDirectoryUser(u: {
  id: string;
  directoryId: string;
  organizationId: string | null;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  state: string;
  groups?: Array<{ id: string; name: string; directoryId: string }>;
}): WorkosDirectoryUser {
  return {
    id: u.id,
    directoryId: u.directoryId,
    organizationId: u.organizationId,
    email: u.email ? u.email.toLowerCase() : null,
    firstName: u.firstName,
    lastName: u.lastName,
    state: u.state,
    groups: (u.groups ?? []).map((g) => ({ id: g.id, name: g.name, directoryId: g.directoryId })),
  };
}

export async function listDirectoryUsers(directoryId: string): Promise<WorkosDirectoryUser[]> {
  const page = await workos.directorySync.listUsers({ directory: directoryId, limit: 100 });
  const all = await page.autoPagination();
  return all.map(toDirectoryUser);
}

/** The directory user with their current groups; the authoritative read for a role decision. */
export async function getDirectoryUser(id: string): Promise<WorkosDirectoryUser> {
  return toDirectoryUser(await workos.directorySync.getUser(id));
}

/**
 * A short-lived Admin Portal link (WorkOS expires it after five minutes) for
 * the customer's IT admin. Generated on demand and never stored.
 */
export async function generatePortalLink(
  workosOrgId: string,
  intent: PortalIntent,
  returnUrl: string,
): Promise<string> {
  const { link } = await workos.portal.generateLink({
    intent: PORTAL_INTENTS[intent],
    organization: workosOrgId,
    returnUrl,
    successUrl: returnUrl,
  });
  return link;
}

/**
 * The WorkOS user for a directory user's email, created if there is none.
 * Only ever called for emails inside the org's verified domains: the domain
 * proof is what makes marking the address verified honest.
 */
export async function findOrCreateUser(input: {
  email: string;
  firstName: string | null;
  lastName: string | null;
}): Promise<{ id: string; email: string; firstName: string | null; lastName: string | null }> {
  const found = await workos.userManagement.listUsers({ email: input.email, limit: 1 });
  const existing = found.data[0];
  if (existing) {
    return {
      id: existing.id,
      email: existing.email,
      firstName: existing.firstName,
      lastName: existing.lastName,
    };
  }
  const created = await workos.userManagement.createUser({
    email: input.email,
    emailVerified: true,
    ...(input.firstName ? { firstName: input.firstName } : {}),
    ...(input.lastName ? { lastName: input.lastName } : {}),
  });
  return {
    id: created.id,
    email: created.email,
    firstName: created.firstName,
    lastName: created.lastName,
  };
}

/** How one WorkOS session was established, or null when WorkOS no longer lists it. */
export async function getSessionAuth(
  userId: string,
  sessionId: string,
): Promise<WorkosSessionAuth | null> {
  const list = await workos.userManagement.listSessions(userId, { limit: 100 });
  const all = await list.autoPagination();
  const s = all.find((x) => x.id === sessionId);
  if (!s) return null;
  return { authMethod: s.authMethod, organizationId: s.organizationId ?? null, status: s.status };
}

/** End every live WorkOS session the user holds. Returns how many were revoked. */
export async function revokeAllSessions(userId: string): Promise<number> {
  const list = await workos.userManagement.listSessions(userId, { limit: 100 });
  const all = await list.autoPagination();
  let revoked = 0;
  for (const s of all) {
    if (s.status !== "active") continue;
    try {
      await workos.userManagement.revokeSession({ sessionId: s.id });
      revoked++;
    } catch (err) {
      console.error(`[sso] revoking session ${s.id} failed:`, err);
    }
  }
  return revoked;
}

/** AuthKit authorization URL that sends the user straight to an org's SSO connection. */
export function ssoAuthorizationUrl(input: {
  workosOrgId: string;
  redirectUri: string;
  state: string;
  clientId: string;
  loginHint?: string;
}): string {
  return workos.userManagement.getAuthorizationUrl({
    clientId: input.clientId,
    redirectUri: input.redirectUri,
    state: input.state,
    organizationId: input.workosOrgId,
    ...(input.loginHint ? { loginHint: input.loginHint } : {}),
  });
}
