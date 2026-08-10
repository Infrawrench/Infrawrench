/**
 * Linear issue-tracking routes (`/api/org/:orgId/linear/*`).
 *
 * The second tracker next to Jira (`routes/jira.ts`), over the same contract
 * shape: turn a finding — cost anomaly, orphan, oversized resource, posture
 * finding, expiring credential, failed probe — into a Linear issue, and keep
 * the link so a list view can show "already filed" instead of offering the
 * button again.
 *
 * The org's Linear personal API key is a bearer credential for everything the
 * Linear user can see. It is stored encrypted and **never returned by any
 * route here** — `GET /` answers with a redacted `keyHint` in its place, and
 * `PUT /` accepts an omitted key to mean "keep the stored one".
 *
 * Every call into `server-core/linear` from this file is user-initiated, so
 * those helpers throw rather than swallow; {@link linearFailure} maps the
 * thrown {@link LinearApiError} onto a status the client can branch on and a
 * message it can render verbatim.
 */
import { Hono } from "hono";
import { z } from "zod";
import {
  LINEAR_SOURCE_KINDS,
  LinearApiError,
  createLinearIssue,
  deleteLinearIntegration,
  getLinearIntegration,
  listLinearIssueLinks,
  listLinearTeams,
  recordLinearIssueLink,
  setLinearIntegration,
  verifyLinearCredentials,
  verifyStoredLinearCredentials,
} from "@infrawrench/server-core/linear";
import { requirePermission } from "../../auth/permissions";
import { logAudit } from "../../services/audit";
import type { AuthSession } from "../auth-middleware";
import type { Context } from "hono";

declare module "hono" {
  interface ContextVariableMap {
    session: AuthSession;
  }
}

const app = new Hono();

/**
 * Map a Linear failure onto an HTTP response.
 *
 * Same split as the Jira routes: 400 means "fix your input and try again"
 * (missing key, a team the workspace rejected), while 502 means "Linear
 * itself is unhappy" — a revoked key, rate limiting, an outage. Linear
 * reports rate limiting and validation as GraphQL errors on an HTTP 400, so
 * a 400 *from Linear* still lands on 400 here, carrying Linear's wording.
 */
function linearFailure(c: Context, err: unknown) {
  if (err instanceof LinearApiError) {
    // No status ⇒ we never reached Linear: a local validation failure or an
    // unreachable network, both of which are the caller's to fix or retry.
    const status = err.status === null || err.status === 400 || err.status === 422 ? 400 : 502;
    return c.json({ error: err.message }, status);
  }
  console.error("[linear] unexpected route failure:", err);
  return c.json({ error: "Linear request failed" }, 500);
}

// --- Integration ---

const integrationBody = z.object({
  /** Omitted ⇒ keep the stored key. Required only on first connect. */
  apiKey: z.string().min(1).max(1024).optional(),
  defaultTeamId: z.string().max(64).nullish(),
});

/**
 * GET /api/org/:orgId/linear — the org's connection, redacted.
 *
 * `linear:read` rather than `linear:write`: members need to know whether
 * filing is available at all, and this response deliberately contains nothing
 * secret.
 */
app.get("/", async (c) => {
  requirePermission(c, "linear:read");
  const integration = await getLinearIntegration(c.get("organizationId"));
  return c.json({ integration });
});

/** PUT /api/org/:orgId/linear — connect Linear, or update the connection. */
app.put("/", async (c) => {
  requirePermission(c, "linear:write");
  const organizationId = c.get("organizationId");
  const session = c.get("session");

  const parsed = integrationBody.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({ error: "Invalid Linear settings", issues: parsed.error.issues }, 400);
  }

  try {
    const integration = await setLinearIntegration({
      organizationId,
      userId: session.userId,
      apiKey: parsed.data.apiKey,
      defaultTeamId: parsed.data.defaultTeamId,
    });

    void logAudit({
      organizationId,
      userId: session.userId,
      action: "linear.configure",
      entityType: "linear_integration",
      entityId: organizationId,
      // The key must not reach the audit log, which is readable by every
      // holder of `audit:read` — only whether it changed, and the default team.
      metadata: {
        keyChanged: parsed.data.apiKey !== undefined,
        defaultTeamId: integration.defaultTeamId,
      },
    });
    return c.json(integration);
  } catch (err) {
    return linearFailure(c, err);
  }
});

/** DELETE /api/org/:orgId/linear — disconnect. Existing issue links are kept. */
app.delete("/", async (c) => {
  requirePermission(c, "linear:write");
  const organizationId = c.get("organizationId");
  const session = c.get("session");

  const existed = await deleteLinearIntegration(organizationId);
  if (!existed) return c.json({ error: "Linear is not connected" }, 404);

  void logAudit({
    organizationId,
    userId: session.userId,
    action: "linear.delete",
    entityType: "linear_integration",
    entityId: organizationId,
  });
  return c.json({ ok: true });
});

const verifyBody = z.object({
  apiKey: z.string().min(1).max(1024).optional(),
});

/**
 * POST /api/org/:orgId/linear/verify — check the key against Linear.
 *
 * With a key in the body this tests one the user has typed but not yet saved,
 * which is the point: Save can tell them the key is wrong immediately instead
 * of letting them find out on the first attempt to file. With an empty body
 * it re-tests the stored one.
 */
app.post("/verify", async (c) => {
  requirePermission(c, "linear:write");
  const organizationId = c.get("organizationId");

  const raw = await c.req.json().catch(() => ({}));
  const parsed = verifyBody.safeParse(raw ?? {});
  if (!parsed.success) {
    return c.json({ error: "Invalid Linear credentials", issues: parsed.error.issues }, 400);
  }

  try {
    const user = parsed.data.apiKey
      ? await verifyLinearCredentials(parsed.data.apiKey)
      : await verifyStoredLinearCredentials(organizationId);
    return c.json({ ok: true, ...user });
  } catch (err) {
    return linearFailure(c, err);
  }
});

// --- Pickers ---

/**
 * GET /api/org/:orgId/linear/teams — teams for the team picker.
 *
 * `linear:read`, not `linear:write`: this also backs the read-only display of
 * a team id as a name in the settings section.
 */
app.get("/teams", async (c) => {
  requirePermission(c, "linear:read");
  try {
    return c.json(await listLinearTeams(c.get("organizationId")));
  } catch (err) {
    return linearFailure(c, err);
  }
});

// --- Issues ---

const createIssueBody = z.object({
  sourceKind: z.enum(LINEAR_SOURCE_KINDS),
  sourceId: z.string().min(1).max(512),
  teamId: z.string().min(1).max(64),
  title: z.string().min(1).max(255),
  /** Markdown — passed to Linear as-is, unlike Jira's server-side ADF conversion. */
  description: z.string().max(30_000).optional(),
  labelIds: z.array(z.string().max(64)).max(20).optional(),
  projectId: z.string().max(64).optional(),
});

/**
 * POST /api/org/:orgId/linear/issues — file a finding as an issue.
 *
 * Order matters, exactly as on the Jira route: the issue is created first,
 * then the link row is written. The reverse would leave a link pointing at an
 * issue that does not exist if the create failed; as it stands the worst case
 * is a created issue whose link row failed to save, which surfaces as an
 * offer to file again — visible and recoverable, where a dangling link is
 * neither.
 */
app.post("/issues", async (c) => {
  requirePermission(c, "linear:write");
  const organizationId = c.get("organizationId");
  const session = c.get("session");

  const parsed = createIssueBody.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({ error: "Invalid issue", issues: parsed.error.issues }, 400);
  }
  const body = parsed.data;

  try {
    const issue = await createLinearIssue({
      organizationId,
      teamId: body.teamId,
      title: body.title,
      description: body.description,
      labelIds: body.labelIds,
      projectId: body.projectId,
    });

    const link = await recordLinearIssueLink({
      organizationId,
      userId: session.userId,
      sourceKind: body.sourceKind,
      sourceId: body.sourceId,
      issueIdentifier: issue.identifier,
      issueUrl: issue.url,
    });

    void logAudit({
      organizationId,
      userId: session.userId,
      action: "linear.issue.create",
      entityType: "linear_issue_link",
      entityId: link.id,
      metadata: {
        sourceKind: body.sourceKind,
        sourceId: body.sourceId,
        issueIdentifier: issue.identifier,
        teamId: body.teamId,
      },
    });

    return c.json({ issue, link });
  } catch (err) {
    return linearFailure(c, err);
  }
});

const linksQuery = z.object({
  sourceKind: z.enum(LINEAR_SOURCE_KINDS).optional(),
  sourceId: z.array(z.string().max(512)).max(500).optional(),
});

/**
 * GET /api/org/:orgId/linear/links?sourceKind=&sourceId=&sourceId=…
 *
 * The batch lookup a list view calls once before rendering. Repeating
 * `sourceId` narrows to specific findings; omitting it returns every link of
 * the kind, which is what a page showing all anomalies wants.
 */
app.get("/links", async (c) => {
  requirePermission(c, "linear:read");
  const parsed = linksQuery.safeParse({
    sourceKind: c.req.query("sourceKind"),
    sourceId: c.req.queries("sourceId"),
  });
  if (!parsed.success) {
    return c.json({ error: "Invalid link filter", issues: parsed.error.issues }, 400);
  }

  return c.json(
    await listLinearIssueLinks(c.get("organizationId"), {
      sourceKind: parsed.data.sourceKind,
      sourceIds: parsed.data.sourceId,
    }),
  );
});

export { app as linearRoutes };
