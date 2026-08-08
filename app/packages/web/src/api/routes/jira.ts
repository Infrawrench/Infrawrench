/**
 * Jira issue-tracking routes (`/api/org/:orgId/jira/*`).
 *
 * Turns a finding — cost anomaly, orphan, oversized resource, posture finding,
 * expiring credential, failed probe — into a Jira issue, and keeps the link so
 * a list view can show "already filed" instead of offering the button again.
 *
 * The org's Jira API token is a bearer credential for a whole Atlassian
 * account. It is stored encrypted and **never returned by any route here** —
 * `GET /` answers with a redacted `tokenHint` in its place, and `PUT /` accepts
 * an omitted token to mean "keep the stored one".
 *
 * Every call into `server-core/jira` from this file is user-initiated, so those
 * helpers throw rather than swallow; {@link jiraFailure} maps the thrown
 * {@link JiraApiError} onto a status the client can branch on and a message it
 * can render verbatim.
 */
import { Hono } from "hono";
import { z } from "zod";
import {
  JIRA_SOURCE_KINDS,
  JiraApiError,
  createJiraIssue,
  deleteJiraIntegration,
  getJiraIntegration,
  listJiraIssueLinks,
  listJiraIssueTypes,
  listJiraProjects,
  recordJiraIssueLink,
  setJiraIntegration,
  verifyJiraCredentials,
  verifyStoredJiraCredentials,
} from "@infrawrench/server-core/jira";
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
 * Map a Jira failure onto an HTTP response.
 *
 * The distinction that matters to a client: 400 means "fix your input and try
 * again" (bad site URL, missing token, project rejected the fields), while 502
 * means "Jira itself is unhappy" — a revoked token, a permission the account
 * lacks, an outage. Both carry Jira's own wording, because "Jira rejected the
 * credentials (401)" is the only thing that tells the user what to do next.
 */
function jiraFailure(c: Context, err: unknown) {
  if (err instanceof JiraApiError) {
    // No status ⇒ we never reached Jira: a local validation failure or an
    // unreachable host, both of which are the caller's to fix.
    const status = err.status === null || err.status === 400 || err.status === 422 ? 400 : 502;
    return c.json({ error: err.message }, status);
  }
  console.error("[jira] unexpected route failure:", err);
  return c.json({ error: "Jira request failed" }, 500);
}

// --- Integration ---

const integrationBody = z.object({
  siteUrl: z.string().min(1).max(255),
  accountEmail: z.string().email().max(255),
  /** Omitted ⇒ keep the stored token. Required only on first connect. */
  apiToken: z.string().min(1).max(1024).optional(),
  defaultProjectKey: z.string().max(64).nullish(),
  defaultIssueTypeId: z.string().max(64).nullish(),
});

/**
 * GET /api/org/:orgId/jira — the org's connection, redacted.
 *
 * `jira:read` rather than `jira:write`: members need to know whether filing is
 * available at all, and this response deliberately contains nothing secret.
 */
app.get("/", async (c) => {
  requirePermission(c, "jira:read");
  const integration = await getJiraIntegration(c.get("organizationId"));
  return c.json({ integration });
});

/** PUT /api/org/:orgId/jira — connect Jira, or update the connection. */
app.put("/", async (c) => {
  requirePermission(c, "jira:write");
  const organizationId = c.get("organizationId");
  const session = c.get("session");

  const parsed = integrationBody.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({ error: "Invalid Jira settings", issues: parsed.error.issues }, 400);
  }

  try {
    const integration = await setJiraIntegration({
      organizationId,
      userId: session.userId,
      siteUrl: parsed.data.siteUrl,
      accountEmail: parsed.data.accountEmail,
      apiToken: parsed.data.apiToken,
      defaultProjectKey: parsed.data.defaultProjectKey,
      defaultIssueTypeId: parsed.data.defaultIssueTypeId,
    });

    void logAudit({
      organizationId,
      userId: session.userId,
      action: "jira.configure",
      entityType: "jira_integration",
      entityId: organizationId,
      // Site and account only. The token must not reach the audit log, which is
      // readable by every holder of `audit:read`.
      metadata: {
        siteUrl: integration.siteUrl,
        accountEmail: integration.accountEmail,
        tokenChanged: parsed.data.apiToken !== undefined,
        defaultProjectKey: integration.defaultProjectKey,
      },
    });
    return c.json(integration);
  } catch (err) {
    return jiraFailure(c, err);
  }
});

/** DELETE /api/org/:orgId/jira — disconnect. Existing issue links are kept. */
app.delete("/", async (c) => {
  requirePermission(c, "jira:write");
  const organizationId = c.get("organizationId");
  const session = c.get("session");

  const existed = await deleteJiraIntegration(organizationId);
  if (!existed) return c.json({ error: "Jira is not connected" }, 404);

  void logAudit({
    organizationId,
    userId: session.userId,
    action: "jira.delete",
    entityType: "jira_integration",
    entityId: organizationId,
  });
  return c.json({ ok: true });
});

const verifyBody = z.object({
  siteUrl: z.string().min(1).max(255).optional(),
  accountEmail: z.string().email().max(255).optional(),
  apiToken: z.string().min(1).max(1024).optional(),
});

/**
 * POST /api/org/:orgId/jira/verify — check credentials against Jira.
 *
 * With a full triple in the body this tests credentials the user has typed but
 * not yet saved, which is the point: Save can tell them the token is wrong
 * immediately instead of letting them find out on the first attempt to file.
 * With an empty body it re-tests the stored ones.
 */
app.post("/verify", async (c) => {
  requirePermission(c, "jira:write");
  const organizationId = c.get("organizationId");

  const raw = await c.req.json().catch(() => ({}));
  const parsed = verifyBody.safeParse(raw ?? {});
  if (!parsed.success) {
    return c.json({ error: "Invalid Jira credentials", issues: parsed.error.issues }, 400);
  }

  const { siteUrl, accountEmail, apiToken } = parsed.data;
  try {
    const account =
      siteUrl && accountEmail && apiToken
        ? await verifyJiraCredentials({ siteUrl, accountEmail, apiToken })
        : await verifyStoredJiraCredentials(organizationId);
    return c.json({ ok: true, ...account });
  } catch (err) {
    return jiraFailure(c, err);
  }
});

// --- Pickers ---

/**
 * GET /api/org/:orgId/jira/projects — projects for the project picker.
 *
 * `jira:read`, not `jira:write`: this also backs the read-only display of a
 * project key as a name in a list view.
 */
app.get("/projects", async (c) => {
  requirePermission(c, "jira:read");
  try {
    return c.json(await listJiraProjects(c.get("organizationId")));
  } catch (err) {
    return jiraFailure(c, err);
  }
});

/** GET /api/org/:orgId/jira/projects/:key/issue-types — types valid in one project. */
app.get("/projects/:key/issue-types", async (c) => {
  requirePermission(c, "jira:read");
  try {
    return c.json(await listJiraIssueTypes(c.get("organizationId"), c.req.param("key")));
  } catch (err) {
    return jiraFailure(c, err);
  }
});

// --- Issues ---

const createIssueBody = z.object({
  sourceKind: z.enum(JIRA_SOURCE_KINDS),
  sourceId: z.string().min(1).max(512),
  projectKey: z.string().min(1).max(64),
  issueTypeId: z.string().min(1).max(64),
  summary: z.string().min(1).max(255),
  description: z.string().max(30_000).optional(),
  labels: z.array(z.string().max(255)).max(20).optional(),
});

/**
 * POST /api/org/:orgId/jira/issues — file a finding as an issue.
 *
 * Order matters: the issue is created first, then the link row is written. The
 * reverse would leave a link pointing at an issue that does not exist if the
 * create failed. As it stands the worst case is a created issue whose link row
 * failed to save, which surfaces as an offer to file again — visible and
 * recoverable, where a dangling link is neither.
 */
app.post("/issues", async (c) => {
  requirePermission(c, "jira:write");
  const organizationId = c.get("organizationId");
  const session = c.get("session");

  const parsed = createIssueBody.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({ error: "Invalid issue", issues: parsed.error.issues }, 400);
  }
  const body = parsed.data;

  try {
    const issue = await createJiraIssue({
      organizationId,
      projectKey: body.projectKey,
      issueTypeId: body.issueTypeId,
      summary: body.summary,
      description: body.description,
      labels: body.labels,
    });

    const link = await recordJiraIssueLink({
      organizationId,
      userId: session.userId,
      sourceKind: body.sourceKind,
      sourceId: body.sourceId,
      issueKey: issue.key,
      issueUrl: issue.url,
    });

    void logAudit({
      organizationId,
      userId: session.userId,
      action: "jira.issue.create",
      entityType: "jira_issue_link",
      entityId: link.id,
      metadata: {
        sourceKind: body.sourceKind,
        sourceId: body.sourceId,
        issueKey: issue.key,
        projectKey: body.projectKey,
      },
    });

    return c.json({ issue, link });
  } catch (err) {
    return jiraFailure(c, err);
  }
});

const linksQuery = z.object({
  sourceKind: z.enum(JIRA_SOURCE_KINDS).optional(),
  sourceId: z.array(z.string().max(512)).max(500).optional(),
});

/**
 * GET /api/org/:orgId/jira/links?sourceKind=&sourceId=&sourceId=…
 *
 * The batch lookup a list view calls once before rendering. Repeating
 * `sourceId` narrows to specific findings; omitting it returns every link of
 * the kind, which is what a page showing all anomalies wants.
 */
app.get("/links", async (c) => {
  requirePermission(c, "jira:read");
  const parsed = linksQuery.safeParse({
    sourceKind: c.req.query("sourceKind"),
    sourceId: c.req.queries("sourceId"),
  });
  if (!parsed.success) {
    return c.json({ error: "Invalid link filter", issues: parsed.error.issues }, 400);
  }

  return c.json(
    await listJiraIssueLinks(c.get("organizationId"), {
      sourceKind: parsed.data.sourceKind,
      sourceIds: parsed.data.sourceId,
    }),
  );
});

export { app as jiraRoutes };
