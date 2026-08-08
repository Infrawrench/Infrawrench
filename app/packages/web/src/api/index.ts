import { Hono } from "hono";
import workflowRoutes from "./routes/workflows.js";
import workflowApprovalRoutes from "./routes/workflow-approvals.js";
import deploymentRoutes from "./routes/deployments";
import agentRoutes from "./routes/agents.js";
import { HTTPException } from "hono/http-exception";
import { setCookie } from "hono/cookie";
import { randomBytes, randomUUID } from "node:crypto";
import { apiReference } from "@scalar/hono-api-reference";
import { sessionMiddleware, orgMiddleware, permissionsMiddleware } from "./auth-middleware";
import { securityHeaders } from "./security-headers";
import { workos, clientId } from "../auth/workos";
import { getPublicOpenApiDocument } from "./openapi/index";
import {
  OAUTH_STATE_COOKIE,
  RETURN_TO_COOKIE,
  OAUTH_COOKIE_MAX_AGE,
  safeReturnPath,
} from "./oauth-state";

import { callbackRoutes } from "./routes/callback";
import { stripeWebhookRoutes } from "./routes/stripe-webhook";
import { workflowGitWebhook } from "./routes/workflows-git";
import { githubRoutes, githubSetupRoute } from "./routes/github";

import { authRoutes } from "./routes/auth";
import { profileRoutes } from "./routes/profile";

import { orgManagementRoutes } from "./routes/orgs";
import { invitationAcceptRoutes } from "./routes/invitation-accept";
import { adminRoutes } from "./routes/admin";

import { dashboardRoutes } from "./routes/dashboards";
import { costRoutes } from "./routes/costs";
import { orphanRoutes } from "./routes/orphans";
import { rightsizingRoutes } from "./routes/rightsizing";
import { costIngestRoutes } from "./routes/cost-ingest";
import { pageRoutes } from "./routes/pages";
import { budgetRoutes } from "./routes/budgets";
import { metricAlertRoutes } from "./routes/metric-alerts";
import { changeFreezeRoutes } from "./routes/change-freezes";
import { tagPolicyRoutes } from "./routes/tag-policy";
import { costCentreRoutes } from "./routes/cost-centres";
import { customGraphRoutes } from "./routes/custom-graphs";
import { accountRoutes } from "./routes/accounts";
import { apiKeyRoutes } from "./routes/api-keys";
import { teamRoutes } from "./routes/team";
import { billingRoutes } from "./routes/billing";
import { auditRoutes } from "./routes/audit";
import { connectionFeatureRoutes } from "./routes/connection-features";
import { resourceDetailRoutes } from "./routes/resource-detail";
import { resourceChangeRoutes } from "./routes/resource-changes";
import { statusIncidentRoutes } from "./routes/status-incidents";
import { expiringRoutes } from "./routes/expiring";
import { postureRoutes } from "./routes/posture";
import { momentRoutes } from "./routes/moment";
import { scheduleRoutes } from "./routes/schedules";
import { leaseRoutes } from "./routes/leases";
import { probeRoutes } from "./routes/probes";
import { logWorkspaceRoutes } from "./routes/log-workspaces";
import { associationRoutes } from "./routes/associations";
import { dependencyGraphRoutes } from "./routes/dependency-graph";
import { wsTokenRoutes } from "./routes/ws-token";
import { storageRoutes } from "./routes/storage";
import { sftpRoutes } from "./routes/sftp";
import { sshKeyRoutes } from "./routes/ssh-keys";
import { sshHostKeyRoutes } from "./routes/ssh-host-keys";
import { searchRoutes } from "./routes/search";
import { connectRoutes } from "./routes/connect";
import { sshTunnelRoutes } from "./routes/ssh-tunnels";
import { sshFanoutRoutes } from "./routes/ssh-fanout";
import { bastionRoutes } from "./routes/bastions";
import { twilioRoutes } from "./routes/twilio";
import { slackRoutes, slackOauthRoute } from "./routes/slack";
import { slackInboundRoutes } from "./routes/slack-inbound";
import { msteamsRoutes } from "./routes/msteams";
import { digestRoutes } from "./routes/digest";
import { pushDeviceRoutes, pushOrgRoutes } from "./routes/push-devices";

// API-key-authed; handles its own auth.
import { syncRoutes } from "./routes/sync";
import { chatRoutes } from "./routes/chat";

import { wellKnownRoutes } from "../mcp/well-known";

const api = new Hono();

// First middleware on the stack so every response below — including the ones
// `onError` synthesizes — carries the baseline headers. `prodApp` in server.ts
// mounts the same middleware for static and SPA responses.
api.use("*", securityHeaders());

api.onError((err, c) => {
  if (err instanceof HTTPException) return err.getResponse();
  // In production we don't echo the message/stack — they leak schema, paths, secrets.
  const correlationId = randomUUID();
  console.error(`[api] uncaught error correlationId=${correlationId}:`, err);
  if (process.env["NODE_ENV"] === "production") {
    return c.json({ error: "Internal server error", correlationId }, 500);
  }
  const message = err instanceof Error ? err.message : String(err);
  return c.json({ error: message, correlationId }, 500);
});

api.route("/callback", callbackRoutes);
api.route("/api/v1/webhooks/stripe", stripeWebhookRoutes);
// Public git webhook for workflows (no session; opaque token in path).
api.route("/api", workflowGitWebhook);
// Public GitHub App setup callback (no session; signed `state` binds the org).
api.route("/api", githubSetupRoute);
// Public Slack OAuth callback (no session; signed `state` binds the org).
api.route("/api", slackOauthRoute);
// Inbound Slack: slash commands + interactivity (signature-verified), and the
// session-authed account-link landing (it bounces through sign-in itself).
api.route("/api", slackInboundRoutes);
api.route("/.well-known", wellKnownRoutes);

/**
 * The `@scalar/api-reference` standalone bundle the docs page loads. Keep this
 * in step with the `@scalar/hono-api-reference` dependency: the integration
 * emits a config shape the bundle has to understand, and a drifting pair
 * renders a half-broken page (client-library picker showing bare labels, etc.).
 */
const SCALAR_VERSION = "1.63.0";

// Public — the spec describes the API surface, not private data. Internal
// routes (platform admin, webhooks, browser auth, desktop sync, ws-token, push)
// and the `sessionCookie` scheme are stripped here; see `openapi/public-spec.ts`.
api.get("/openapi.json", async (c) => c.json(await getPublicOpenApiDocument()));
api.get(
  "/docs",
  apiReference({
    url: "/openapi.json",
    pageTitle: "Infrawrench API",
    theme: "default",
    // Pin the standalone bundle. The default CDN URL is unversioned, so the
    // docs UI would otherwise track upstream releases — which is how the page
    // ended up rendering a v1 bundle against a v0.5 config shape.
    cdn: `https://cdn.jsdelivr.net/npm/@scalar/api-reference@${SCALAR_VERSION}`,
    // Snippets for languages we can actually vouch for, with curl the default.
    // Left unfiltered, Scalar offers ~35 clients (Clojure, OCaml, ObjC…) that
    // nobody here has run against this API.
    defaultHttpClient: { targetKey: "shell", clientKey: "curl" },
    hiddenClients: {
      c: true,
      clojure: true,
      csharp: true,
      dart: true,
      http: true,
      java: true,
      kotlin: true,
      objc: true,
      ocaml: true,
      php: true,
      powershell: true,
      r: true,
      ruby: true,
      swift: true,
      // Keep one idiomatic client per remaining language.
      shell: ["httpie", "wget"],
      js: ["axios", "jquery", "ofetch", "xhr"],
      node: ["axios", "ofetch", "undici"],
      python: ["python3"],
    },
  }),
);

api.get("/api/auth/sign-in", async (c) => {
  const redirectUri = process.env["WORKOS_REDIRECT_URI"] ?? "http://localhost:3000/callback";
  // Per-request nonce. The callback verifies the cookie matches the returned
  // `state` parameter, blocking login CSRF.
  const state = randomBytes(32).toString("base64url");
  setCookie(c, OAUTH_STATE_COOKIE, state, {
    httpOnly: true,
    secure: process.env["NODE_ENV"] === "production",
    sameSite: "lax",
    path: "/",
    maxAge: OAUTH_COOKIE_MAX_AGE,
  });
  // Where to land afterwards. Used by the step-up flow so a user sent back to
  // sign-in mid-settings-change returns to the page they were on. Validated to
  // a same-origin path — an open redirect here would be a phishing primitive.
  const returnTo = safeReturnPath(c.req.query("return_to"));
  if (returnTo) {
    setCookie(c, RETURN_TO_COOKIE, returnTo, {
      httpOnly: true,
      secure: process.env["NODE_ENV"] === "production",
      sameSite: "lax",
      path: "/",
      maxAge: OAUTH_COOKIE_MAX_AGE,
    });
  }
  const url = workos.userManagement.getAuthorizationUrl({
    provider: "authkit",
    clientId,
    redirectUri,
    state,
  });
  return c.redirect(url);
});

api.route("/api/v1/sync", syncRoutes);

// Chat handles its own auth so it can serve both session-cookie UI clients
// and `iwk_` API-key holders with the `chat:write` scope.
api.route("/api/org/:orgId/chat", chatRoutes);

// Push-up surfaces for servers outside Infrawrench. Same reason as chat: the
// org tree's session middleware 401s `iwk_` keys, so these authenticate
// themselves (see auth/org-request-auth.ts). Registered before the org tree so
// `POST /costs/rows` resolves here; every other `/costs/*` path falls through
// to the session-authed router below.
api.route("/api/org/:orgId/costs", costIngestRoutes);
api.route("/api/org/:orgId/pages", pageRoutes);

const authed = new Hono();
authed.use("*", sessionMiddleware);

authed.route("/auth", authRoutes);
// Personal account settings — user-scoped, so it lives outside the org tree.
authed.route("/profile", profileRoutes);
authed.route("/orgs", orgManagementRoutes);
authed.route("/invitations", invitationAcceptRoutes);
// Platform-admin surface — session-authed here, allowlist-gated inside.
authed.route("/admin", adminRoutes);
// Push devices are user-scoped (a phone registers once across orgs).
authed.route("/push", pushDeviceRoutes);

api.route("/api", authed);

const orgScoped = new Hono();
orgScoped.use("*", sessionMiddleware);
orgScoped.use("*", orgMiddleware);
orgScoped.use("*", permissionsMiddleware);

orgScoped.route("/dashboards", dashboardRoutes);
orgScoped.route("/costs", costRoutes);
orgScoped.route("/orphans", orphanRoutes);
orgScoped.route("/rightsizing", rightsizingRoutes);
orgScoped.route("/budgets", budgetRoutes);
orgScoped.route("/metric-alerts", metricAlertRoutes);
orgScoped.route("/change-freezes", changeFreezeRoutes);
orgScoped.route("/tag-policy", tagPolicyRoutes);
orgScoped.route("/cost-centres", costCentreRoutes);
orgScoped.route("/custom-graphs", customGraphRoutes);
orgScoped.route("/workflows", workflowRoutes);
orgScoped.route("/workflow-approvals", workflowApprovalRoutes);
orgScoped.route("/deployments", deploymentRoutes);
orgScoped.route("/agents", agentRoutes);
orgScoped.route("/github", githubRoutes);
orgScoped.route("/accounts", accountRoutes);
orgScoped.route("/api-keys", apiKeyRoutes);
orgScoped.route("/team", teamRoutes);
orgScoped.route("/billing", billingRoutes);
orgScoped.route("/audit-logs", auditRoutes);
orgScoped.route("/", connectionFeatureRoutes);
orgScoped.route("/resources", resourceDetailRoutes);
orgScoped.route("/changes", resourceChangeRoutes);
orgScoped.route("/status-incidents", statusIncidentRoutes);
orgScoped.route("/expiring", expiringRoutes);
orgScoped.route("/posture", postureRoutes);
orgScoped.route("/moment", momentRoutes);
orgScoped.route("/schedules", scheduleRoutes);
orgScoped.route("/leases", leaseRoutes);
orgScoped.route("/probes", probeRoutes);
orgScoped.route("/log-workspaces", logWorkspaceRoutes);
orgScoped.route("/associations", associationRoutes);
orgScoped.route("/dependency-graph", dependencyGraphRoutes);
orgScoped.route("/ws-token", wsTokenRoutes);
orgScoped.route("/v1/storage", storageRoutes);
orgScoped.route("/v1/sftp", sftpRoutes);
orgScoped.route("/ssh-keys", sshKeyRoutes);
orgScoped.route("/ssh-host-keys", sshHostKeyRoutes);
orgScoped.route("/search", searchRoutes);
orgScoped.route("/connect", connectRoutes);
orgScoped.route("/ssh-tunnels", sshTunnelRoutes);
orgScoped.route("/ssh-fanout", sshFanoutRoutes);
orgScoped.route("/bastions", bastionRoutes);
orgScoped.route("/twilio", twilioRoutes);
orgScoped.route("/slack", slackRoutes);
orgScoped.route("/msteams", msteamsRoutes);
orgScoped.route("/digest", digestRoutes);
orgScoped.route("/push", pushOrgRoutes);

api.route("/api/org/:orgId", orgScoped);

export { api };
