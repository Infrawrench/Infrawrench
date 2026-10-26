/**
 * Agent links: the device flow a platform starts and a person approves, and
 * the link-authenticated surface the platform then drives.
 *
 * Three audiences, three auth models, kept on separate routers so mounting one
 * can never put another behind the wrong layer:
 *
 * - **`/api/agent-links/requests`** and **`/requests/token`** take no auth: a
 *   platform with no credential asks for one and polls for the answer. Rate
 *   limited per address in `agent-links/links.ts`.
 * - **`/api/agent-links/requests/{lookup,approve,deny}`** are the person's
 *   half, session-only, behind a per-user attempt limit (the user code is
 *   looked up globally, exactly like a claim code).
 * - **`/api/agent-link`** authenticates with the link's own `iwl_` credential
 *   and reaches nothing but the link and the agents it made.
 *
 * The org tree's view (Settings → Agents) lives in `agent-links-org.ts`.
 */
import { Hono, type Context } from "hono";
import { createMiddleware } from "hono/factory";
import { AGENT_SCOPES } from "@infrawrench/ui/settings/api-key-scopes";
import {
  AgentLinkError,
  EXTERNAL_ID_MAX,
  LABEL_MAX,
  LINK_POLL_INTERVAL_S,
  LINK_REQUEST_TTL_MS,
  PLATFORM_SLUG,
  approveLinkRequest,
  createLinkRequest,
  createPlatformAgent,
  denyLinkRequest,
  getLinkAgent,
  grantablePermissions,
  linkEffectiveScopes,
  listLinkAgents,
  lookupLinkRequest,
  pollLinkRequest,
  resolveLinkCredential,
  revokeLink,
  revokePlatformAgent,
  rotatePlatformAgent,
  touchLink,
  updatePlatformAgent,
  validateAgentGrant,
  type AgentLinkRow,
} from "@infrawrench/server-core/agent-links/links";
import { keepAlive } from "@infrawrench/server-core/runtime/request-scope";
import { listUserOrganizations, sessionMiddleware } from "../auth-middleware";
import { logAudit } from "../../services/audit";
import { buildLinkInfo, serializeAgent, unknownProviders } from "../../services/agent-links";
import { clientIp, publicBaseUrl } from "./agent-auth";

/** Turn an {@link AgentLinkError} into the contract's error body. */
function linkError(c: Context, e: unknown) {
  if (e instanceof AgentLinkError) {
    return c.json(
      { error: e.message, ...(e.code ? { code: e.code } : {}), ...(e.details ?? {}) },
      e.status as 400,
    );
  }
  throw e;
}

async function readJson(c: Context): Promise<Record<string, unknown>> {
  const body = await c.req.json<unknown>().catch(() => null);
  return body && typeof body === "object" && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : {};
}

function boundedString(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length >= 1 && trimmed.length <= max ? trimmed : null;
}

// ─── The device flow ────────────────────────────────────────────────────────

const requests = new Hono();

/** POST /api/agent-links/requests: a platform asks to be linked. */
requests.post("/", async (c) => {
  const body = await readJson(c);
  const platform = typeof body["platform"] === "string" ? body["platform"] : "";
  if (!PLATFORM_SLUG.test(platform)) {
    return c.json(
      { error: "`platform` must match [a-z0-9-]{1,40}.", code: "invalid_platform" },
      400,
    );
  }
  const label = boundedString(body["label"], LABEL_MAX);
  if (!label) {
    return c.json({ error: `\`label\` must be 1 to ${LABEL_MAX} characters.` }, 400);
  }
  const requested = body["requestedScopes"];
  if (requested !== undefined && !Array.isArray(requested)) {
    return c.json({ error: "`requestedScopes` must be an array of permission strings." }, 400);
  }
  // Pre-ticks only, so an unknown string is dropped rather than refused: a
  // platform built against a newer catalog should still be able to link.
  const requestedScopes = [
    ...new Set(
      (requested ?? []).filter(
        (s): s is string => typeof s === "string" && AGENT_SCOPES.includes(s),
      ),
    ),
  ];

  try {
    const started = await createLinkRequest({
      platform,
      label,
      requestedScopes,
      ip: clientIp(c.req.header("x-forwarded-for")),
    });
    const base = publicBaseUrl(c.req.url, c.req.header("x-forwarded-proto"));
    return c.json(
      {
        deviceCode: started.deviceCode,
        userCode: started.userCode,
        verificationUrl: `${base}/link-agents`,
        verificationUrlComplete: `${base}/link-agents?code=${started.userCode}`,
        expiresIn: Math.round(LINK_REQUEST_TTL_MS / 1000),
        interval: LINK_POLL_INTERVAL_S,
      },
      201,
    );
  } catch (e) {
    return linkError(c, e);
  }
});

/** POST /api/agent-links/requests/token: the platform polls. */
requests.post("/token", async (c) => {
  const body = await readJson(c);
  const deviceCode = typeof body["deviceCode"] === "string" ? body["deviceCode"] : "";
  if (!deviceCode) return c.json({ error: "`deviceCode` is required." }, 400);

  const result = await pollLinkRequest(deviceCode);
  if (result.status === "slow_down") return c.json({ error: "slow_down" }, 429);
  if (result.status !== "approved") return c.json({ status: result.status });

  const link = await resolveLinkCredential(result.credential);
  if (!link) return c.json({ status: "expired" });
  void logAudit({
    organizationId: link.organizationId,
    userId: link.approvedByUserId ?? undefined,
    action: "agent_link.create",
    entityType: "agent_link",
    entityId: link.id,
    metadata: { platform: link.platform, label: link.label, scopes: link.scopes },
  });
  return c.json({
    status: "approved",
    credential: result.credential,
    link: await buildLinkInfo(link),
  });
});

// ─── The person's half ──────────────────────────────────────────────────────

/**
 * Wrong-code lookups per user. In-memory, like the claim page's throttle and
 * for the same reason; these routes are pinned to the session gateway
 * (`edge/gateway-routes.ts`) so the map is per pod rather than per isolate.
 */
const ATTEMPT_WINDOW_MS = 15 * 60 * 1000;
const ATTEMPTS_PER_USER = 10;
const attempts = new Map<string, { count: number; resetAt: number }>();

function tooManyAttempts(userId: string): boolean {
  const now = Date.now();
  const entry = attempts.get(userId);
  if (!entry || entry.resetAt < now) {
    attempts.set(userId, { count: 1, resetAt: now + ATTEMPT_WINDOW_MS });
    return false;
  }
  entry.count += 1;
  return entry.count > ATTEMPTS_PER_USER;
}

/** Test hook. */
export function resetAgentLinkAttemptsForTests(): void {
  attempts.clear();
}

const approval = new Hono();
// Per path, never `use("*")`: mounted at "/" beside the public routes, a
// wildcard would put the session layer in front of the platform's own polls.
for (const path of ["/lookup", "/approve", "/deny"]) approval.use(path, sessionMiddleware);

/**
 * POST /api/agent-links/requests/lookup: what the approval page shows.
 * A POST with the code in the body, never a query string: the code is a live
 * bearer secret, and a URL lands in history, `Referer` and access logs.
 */
approval.post("/lookup", async (c) => {
  const session = c.get("session");
  if (tooManyAttempts(session.userId)) {
    return c.json({ error: "Too many attempts. Wait a few minutes and try again." }, 429);
  }
  const body = await readJson(c);
  const code = typeof body["code"] === "string" ? body["code"] : "";
  if (!code) return c.json({ error: "Enter the code the platform showed you." }, 400);

  try {
    const request = await lookupLinkRequest(code);
    const orgs = await listUserOrganizations(session.userId);
    const organizations = [];
    for (const org of orgs) {
      const grantable = await grantablePermissions(org.id, session.userId);
      const canApprove = grantable.includes("team:invite");
      organizations.push({
        id: org.id,
        name: org.displayName,
        canApprove,
        // What this person could put in the ceiling here: the page offers
        // nothing else, so it never shows a box the approve call would refuse.
        grantableScopes: canApprove ? AGENT_SCOPES.filter((s) => grantable.includes(s)) : [],
      });
    }
    return c.json({
      platform: request.platform,
      label: request.label,
      requestedScopes: request.requestedScopes,
      expiresAt: request.expiresAt.toISOString(),
      organizations,
    });
  } catch (e) {
    return linkError(c, e);
  }
});

/** POST /api/agent-links/requests/approve */
approval.post("/approve", async (c) => {
  const session = c.get("session");
  if (tooManyAttempts(session.userId)) {
    return c.json({ error: "Too many attempts. Wait a few minutes and try again." }, 429);
  }
  const body = await readJson(c);
  const code = typeof body["code"] === "string" ? body["code"] : "";
  const organizationId = typeof body["organizationId"] === "string" ? body["organizationId"] : "";
  const scopes = body["scopes"];
  if (!code || !organizationId) {
    return c.json({ error: "`code` and `organizationId` are required." }, 400);
  }
  if (!Array.isArray(scopes) || scopes.length === 0 || scopes.some((s) => typeof s !== "string")) {
    return c.json({ error: "Choose at least one permission for this link." }, 400);
  }

  try {
    const request = await lookupLinkRequest(code);
    // Elevation excluded, as everywhere an unattended principal is scored: a
    // break-glass grant must not become the ceiling of a standing link.
    const grantable = await grantablePermissions(organizationId, session.userId);
    if (!grantable.includes("team:invite")) {
      return c.json(
        { error: "You need permission to invite people in that organization to link a platform." },
        403,
      );
    }
    const unique = [...new Set(scopes as string[])];
    const notAllowed = unique.filter((s) => !AGENT_SCOPES.includes(s) || !grantable.includes(s));
    if (notAllowed.length > 0) {
      return c.json(
        {
          error: `You cannot grant: ${notAllowed.join(", ")}`,
          code: "scope_not_allowed",
          scopes: notAllowed,
        },
        400,
      );
    }
    await approveLinkRequest({
      requestId: request.id,
      organizationId,
      userId: session.userId,
      scopes: unique,
    });
    void logAudit({
      organizationId,
      userId: session.userId,
      action: "agent_link.approve",
      entityType: "agent_link_request",
      entityId: request.id,
      metadata: { platform: request.platform, label: request.label, scopes: unique },
    });
    return c.json({ ok: true });
  } catch (e) {
    return linkError(c, e);
  }
});

/** POST /api/agent-links/requests/deny */
approval.post("/deny", async (c) => {
  const session = c.get("session");
  if (tooManyAttempts(session.userId)) {
    return c.json({ error: "Too many attempts. Wait a few minutes and try again." }, 429);
  }
  const body = await readJson(c);
  const code = typeof body["code"] === "string" ? body["code"] : "";
  if (!code) return c.json({ error: "`code` is required." }, 400);
  try {
    const request = await lookupLinkRequest(code);
    await denyLinkRequest(request.id, session.userId);
    return c.json({ ok: true });
  } catch (e) {
    return linkError(c, e);
  }
});

const agentLinkRequestRoutes = new Hono();
agentLinkRequestRoutes.route("/", requests);
agentLinkRequestRoutes.route("/", approval);

// ─── The link's own surface ─────────────────────────────────────────────────

type LinkEnv = { Variables: { link: AgentLinkRow } };

const linkAuth = createMiddleware<LinkEnv>(async (c, next) => {
  const header = c.req.header("authorization");
  const token = header?.startsWith("Bearer ") ? header.slice(7) : "";
  const link = token ? await resolveLinkCredential(token) : null;
  if (!link) return c.json({ error: "Unauthorized" }, 401);
  void keepAlive(touchLink(link.id));
  c.set("link", link);
  return next();
});

const linkRoutes = new Hono<LinkEnv>();
linkRoutes.use("*", linkAuth);

/** GET /api/agent-link */
linkRoutes.get("/", async (c) => c.json(await buildLinkInfo(c.get("link"))));

/** DELETE /api/agent-link: unlink, revoking every agent the link made. */
linkRoutes.delete("/", async (c) => {
  const link = c.get("link");
  await revokeLink(link.id);
  void logAudit({
    organizationId: link.organizationId,
    userId: link.approvedByUserId ?? undefined,
    action: "agent_link.revoke",
    entityType: "agent_link",
    entityId: link.id,
    metadata: { platform: link.platform, by: "platform" },
  });
  return c.json({ ok: true });
});

/** GET /api/agent-link/agents */
linkRoutes.get("/agents", async (c) =>
  c.json((await listLinkAgents(c.get("link").id)).map(serializeAgent)),
);

/** Validate a grant against the link's *current* ceiling and the plugin registry. */
async function checkedGrant(link: AgentLinkRow, scopes: unknown, providers: unknown) {
  const grant = validateAgentGrant(await linkEffectiveScopes(link), scopes, providers);
  const unknown = await unknownProviders(grant.providers);
  if (unknown.length > 0) {
    throw new AgentLinkError(`Unknown providers: ${unknown.join(", ")}`, 400, "invalid_provider", {
      providers: unknown,
    });
  }
  return grant;
}

/** POST /api/agent-link/agents */
linkRoutes.post("/agents", async (c) => {
  const link = c.get("link");
  const body = await readJson(c);
  const externalId = boundedString(body["externalId"], EXTERNAL_ID_MAX);
  if (!externalId) {
    return c.json({ error: `\`externalId\` must be 1 to ${EXTERNAL_ID_MAX} characters.` }, 400);
  }
  const label = boundedString(body["label"], LABEL_MAX);
  if (!label) return c.json({ error: `\`label\` must be 1 to ${LABEL_MAX} characters.` }, 400);

  try {
    const grant = await checkedGrant(link, body["scopes"], body["providers"]);
    const created = await createPlatformAgent({
      link,
      externalId,
      label,
      scopes: grant.scopes,
      providers: grant.providers,
    });
    void logAudit({
      organizationId: link.organizationId,
      userId: link.approvedByUserId ?? undefined,
      action: "agent.create",
      entityType: "agent_registration",
      entityId: created.agent.id,
      metadata: {
        linkId: link.id,
        platform: link.platform,
        externalId,
        scopes: grant.scopes,
        providers: grant.providers,
      },
    });
    return c.json({ agent: serializeAgent(created.agent), credential: created.credential }, 201);
  } catch (e) {
    return linkError(c, e);
  }
});

/** PATCH /api/agent-link/agents/:id */
linkRoutes.patch("/agents/:id", async (c) => {
  const link = c.get("link");
  const existing = await getLinkAgent(link.id, c.req.param("id"));
  if (!existing || existing.revokedAt) return c.json({ error: "Agent not found" }, 404);
  const body = await readJson(c);

  let label: string | undefined;
  if (body["label"] !== undefined) {
    const parsed = boundedString(body["label"], LABEL_MAX);
    if (!parsed) return c.json({ error: `\`label\` must be 1 to ${LABEL_MAX} characters.` }, 400);
    label = parsed;
  }
  try {
    const patch: { label?: string; scopes?: string[]; providers?: string[] } = {};
    if (label !== undefined) patch.label = label;
    if (body["scopes"] !== undefined || body["providers"] !== undefined) {
      const grant = await checkedGrant(
        link,
        body["scopes"] ?? existing.scopes ?? [],
        body["providers"] !== undefined ? body["providers"] : (existing.providers ?? []),
      );
      patch.scopes = grant.scopes;
      patch.providers = grant.providers;
    }
    await updatePlatformAgent(existing.id, patch);
    void logAudit({
      organizationId: link.organizationId,
      userId: link.approvedByUserId ?? undefined,
      action: "agent.update",
      entityType: "agent_registration",
      entityId: existing.id,
      metadata: { linkId: link.id, by: "platform", ...patch },
    });
    const updated = await getLinkAgent(link.id, existing.id);
    return c.json({ agent: serializeAgent(updated ?? existing) });
  } catch (e) {
    return linkError(c, e);
  }
});

/** POST /api/agent-link/agents/:id/rotate */
linkRoutes.post("/agents/:id/rotate", async (c) => {
  const link = c.get("link");
  const existing = await getLinkAgent(link.id, c.req.param("id"));
  if (!existing || existing.revokedAt) return c.json({ error: "Agent not found" }, 404);
  const rotated = await rotatePlatformAgent(existing.id);
  if (!rotated) return c.json({ error: "Agent not found" }, 404);
  void logAudit({
    organizationId: link.organizationId,
    userId: link.approvedByUserId ?? undefined,
    action: "agent.rotate",
    entityType: "agent_registration",
    entityId: existing.id,
    metadata: { linkId: link.id },
  });
  const updated = await getLinkAgent(link.id, existing.id);
  return c.json({ agent: serializeAgent(updated ?? existing), credential: rotated.credential });
});

/** DELETE /api/agent-link/agents/:id: revoke, not delete. Idempotent. */
linkRoutes.delete("/agents/:id", async (c) => {
  const link = c.get("link");
  const existing = await getLinkAgent(link.id, c.req.param("id"));
  if (!existing) return c.json({ error: "Agent not found" }, 404);
  const revoked = await revokePlatformAgent(existing.id);
  if (revoked) {
    void logAudit({
      organizationId: link.organizationId,
      userId: link.approvedByUserId ?? undefined,
      action: "agent.revoke",
      entityType: "agent_registration",
      entityId: existing.id,
      metadata: { linkId: link.id, by: "platform" },
    });
  }
  return c.json({ ok: true });
});

export { agentLinkRequestRoutes, linkRoutes as agentLinkRoutes };
