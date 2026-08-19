import { Hono } from "hono";
import workflowRoutes from "./routes/workflows.js";
import workflowApprovalRoutes from "./routes/workflow-approvals.js";
import { workflowSecretRoutes } from "./routes/workflow-secrets.js";
import deploymentRoutes from "./routes/deployments";
import agentRoutes from "./routes/agents.js";
import { HTTPException } from "hono/http-exception";
import { setCookie } from "hono/cookie";
import { randomBytes, randomUUID } from "node:crypto";
import { apiReference } from "@scalar/hono-api-reference";
import {
  sessionMiddleware,
  orgMiddleware,
  permissionsMiddleware,
  apiKeyOrgMiddleware,
  agentOrgMiddleware,
  unlessApiKey,
} from "./auth-middleware";
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
import { agentAuthRoutes, agentClaimRoutes } from "./routes/agent-auth";
import relayRoutes from "./routes/internal-relay";
import { agentRegistrationRoutes } from "./routes/agent-registrations";
import { invitationAcceptRoutes } from "./routes/invitation-accept";
import { adminRoutes } from "./routes/admin";

import { dashboardRoutes } from "./routes/dashboards";
import { costRoutes } from "./routes/costs";
import { costReportRoutes } from "./routes/cost-reports";
import {
  costReportNotificationRoutes,
  orgReportNotificationRoutes,
} from "./routes/cost-report-notifications";
import { costReportFolderRoutes } from "./routes/cost-report-folders";
import { costAnnotationRoutes } from "./routes/cost-annotations";
import { costExportRoutes } from "./routes/cost-exports";
import { costAlertRoutes } from "./routes/cost-alerts";
import { savedFilterRoutes } from "./routes/saved-filters";
import { costScenarioRoutes } from "./routes/cost-scenarios";
import { businessMetricRoutes } from "./routes/business-metrics";
import { orphanRoutes } from "./routes/orphans";
import { environmentDiffRoutes } from "./routes/environment-diff";
import { rightsizingRoutes } from "./routes/rightsizing";
import { costIngestRoutes } from "./routes/cost-ingest";
import { pageRoutes } from "./routes/pages";
import { budgetRoutes } from "./routes/budgets";
import { metricAlertRoutes } from "./routes/metric-alerts";
import { changeFreezeRoutes } from "./routes/change-freezes";
import { tagPolicyRoutes } from "./routes/tag-policy";
import { currencyRoutes } from "./routes/currency";
import { costCentreRoutes } from "./routes/cost-centres";
import { billingRuleRoutes } from "./routes/billing-rules";
import { invoiceRoutes, managedAccountRoutes } from "./routes/invoices";
import { customGraphRoutes } from "./routes/custom-graphs";
import { orgConfigRoutes } from "./routes/org-config";
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
import { quotaRoutes } from "./routes/quotas";
import { postureRoutes } from "./routes/posture";
import { accessReviewRoutes } from "./routes/access-review";
import { backupRoutes } from "./routes/backups";
import { wallboardRoutes } from "./routes/wallboard";
import { calendarRoutes } from "./routes/calendar";
import { publicCalendarRoutes } from "./routes/calendar-feed";
import { alertNoiseRoutes } from "./routes/alert-noise";
import { dnsRoutes } from "./routes/dns";
import { momentRoutes } from "./routes/moment";
import { scheduleRoutes } from "./routes/schedules";
import { leaseRoutes } from "./routes/leases";
import { environmentRoutes } from "./routes/environments";
import { probeRoutes } from "./routes/probes";
import { incidentRoutes } from "./routes/incidents";
import { statusPageRoutes, publicStatusRoutes } from "./routes/status-pages";
import { ownershipRoutes } from "./routes/ownership";
import { iacRoutes } from "./routes/iac";
import { logWorkspaceRoutes } from "./routes/log-workspaces";
import { associationRoutes } from "./routes/associations";
import { dependencyGraphRoutes } from "./routes/dependency-graph";
import { blastRadiusRoutes } from "./routes/blast-radius";
import { wsTokenRoutes } from "./routes/ws-token";
import { storageRoutes } from "./routes/storage";
import { sftpRoutes } from "./routes/sftp";
import { sshKeyRoutes } from "./routes/ssh-keys";
import { sshHostKeyRoutes } from "./routes/ssh-host-keys";
import sessionRecordingRoutes from "./routes/session-recordings.js";
import sharedConsoleRoutes from "./routes/shared-consoles.js";
import accessRequestRoutes from "./routes/access-requests.js";
import credentialHygieneRoutes from "./routes/credential-hygiene.js";
import creditRoutes from "./routes/credits.js";
import commitmentRoutes from "./routes/commitments.js";
import { networkFlowRoutes } from "./routes/network-flows.js";
import { searchRoutes } from "./routes/search";
import { connectRoutes } from "./routes/connect";
import { sshTunnelRoutes } from "./routes/ssh-tunnels";
import { sshFanoutRoutes } from "./routes/ssh-fanout";
import { appsRoutes } from "./routes/apps";
import { bastionRoutes } from "./routes/bastions";
import { twilioRoutes } from "./routes/twilio";
import { slackRoutes, slackOauthRoute } from "./routes/slack";
import { slackInboundRoutes } from "./routes/slack-inbound";
import { msteamsRoutes } from "./routes/msteams";
import { jiraRoutes } from "./routes/jira";
import { linearRoutes } from "./routes/linear";
import { digestRoutes } from "./routes/digest";
import { pushDeviceRoutes, pushOrgRoutes } from "./routes/push-devices";
import alertRuleRoutes from "./routes/alert-rules";

// API-key-authed; handles its own auth.
import { syncRoutes } from "./routes/sync";
import { chatRoutes } from "./routes/chat";

import { wellKnownRoutes } from "../mcp/well-known";
import { authMdRoutes } from "../mcp/auth-md";

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
// `auth.md` at the domain root — the agent-registration skill document the
// `agent_auth` discovery block points at.
api.route("/", authMdRoutes);

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

// Public status pages. Registered outside every auth layer *and* outside the
// org tree, because the whole point is to answer callers with no account and
// the URL deliberately contains no org id — only the page's slug, which is its
// sole credential. The handler can reach nothing but the public payload
// assembler (see routes/status-pages.ts).
api.route("/api/status", publicStatusRoutes);

// Public iCalendar feeds. Outside every auth layer for the same reason as the
// status pages above — a calendar client can hold no session — with a 32-byte
// token in the path as the sole credential and no org id anywhere in the URL.
api.route("/api", publicCalendarRoutes);

// Agent registration and the claim ceremony. Outside every auth layer because
// its whole purpose is serving a caller with no credentials — the rate limit in
// `trials/ceremony.ts` is what stands in for authentication here, and it has to,
// since this is the only route in the product that creates an organization
// without a person behind it.
api.route("/api/agent", agentAuthRoutes);
// The human half of the same ceremony, session-authed on its own router.
api.route("/api/agent/claim", agentClaimRoutes);
// Pod-to-pod: run an operation on the replica that holds its session. Outside
// every auth layer because the caller is another replica, not a person — it
// authenticates with INTERNAL_RELAY_SECRET and forwards work it already
// authorised. See routes/internal-relay.ts for why that is the whole check.
api.route("/api/internal", relayRoutes);

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
// `iwk_` API keys authenticate here, alongside the session cookie and WorkOS
// bearer tokens the three middlewares below have always handled. The key path
// leaves the context in the identical shape — session, organizationId,
// permissions, role, elevations — so every route's `requirePermission` gate
// applies unchanged, over the key's scopes ∩ its owner's current role. Routes
// closed to keys whatever they hold are listed in `auth/api-key-route-policy.ts`.
//
// `unlessApiKey` is a pass-through for every other caller: when no key
// authenticated, each middleware runs exactly as it did before.
orgScoped.use("*", apiKeyOrgMiddleware);
// Agent credentials, same contract: pinned to one org, permissions already
// final, and a denial table of their own on top of the API-key one. Runs after
// the key middleware because the two never both match — a key is recognised by
// prefix and returns early here.
orgScoped.use("*", unlessApiKey(agentOrgMiddleware));
orgScoped.use("*", unlessApiKey(sessionMiddleware));
orgScoped.use("*", unlessApiKey(orgMiddleware));
orgScoped.use("*", unlessApiKey(permissionsMiddleware));

orgScoped.route("/dashboards", dashboardRoutes);
orgScoped.route("/costs", costRoutes);
orgScoped.route("/cost-reports", costReportRoutes);
// Delivery schedules share the /cost-reports prefix (their paths are all
// /:id/notifications…); the org-wide list lives on its own prefix so it can
// never collide with /cost-reports/:id.
orgScoped.route("/cost-reports", costReportNotificationRoutes);
orgScoped.route("/cost-report-notifications", orgReportNotificationRoutes);
orgScoped.route("/cost-report-folders", costReportFolderRoutes);
// Dated notes drawn over cost charts. Its own prefix rather than a child of
// /cost-reports: an annotation with no report id is org-wide and belongs to
// every chart, so it is not a sub-resource of any one report.
orgScoped.route("/cost-annotations", costAnnotationRoutes);
orgScoped.route("/cost-exports", costExportRoutes);
orgScoped.route("/cost-alerts", costAlertRoutes);
orgScoped.route("/saved-cost-filters", savedFilterRoutes);
orgScoped.route("/cost-scenarios", costScenarioRoutes);
orgScoped.route("/business-metrics", businessMetricRoutes);
orgScoped.route("/orphans", orphanRoutes);
orgScoped.route("/rightsizing", rightsizingRoutes);
orgScoped.route("/budgets", budgetRoutes);
orgScoped.route("/metric-alerts", metricAlertRoutes);
orgScoped.route("/change-freezes", changeFreezeRoutes);
orgScoped.route("/tag-policy", tagPolicyRoutes);
orgScoped.route("/currency", currencyRoutes);
orgScoped.route("/cost-centres", costCentreRoutes);
orgScoped.route("/billing-rules", billingRuleRoutes);
orgScoped.route("/managed-accounts", managedAccountRoutes);
orgScoped.route("/invoices", invoiceRoutes);
orgScoped.route("/custom-graphs", customGraphRoutes);
orgScoped.route("/config", orgConfigRoutes);
orgScoped.route("/workflows", workflowRoutes);
orgScoped.route("/workflow-approvals", workflowApprovalRoutes);
orgScoped.route("/workflow-secrets", workflowSecretRoutes);
orgScoped.route("/deployments", deploymentRoutes);
orgScoped.route("/agents", agentRoutes);
orgScoped.route("/github", githubRoutes);
orgScoped.route("/accounts", accountRoutes);
orgScoped.route("/api-keys", apiKeyRoutes);
orgScoped.route("/agent-registrations", agentRegistrationRoutes);
orgScoped.route("/team", teamRoutes);
orgScoped.route("/billing", billingRoutes);
orgScoped.route("/audit-logs", auditRoutes);
orgScoped.route("/", connectionFeatureRoutes);
orgScoped.route("/resources", resourceDetailRoutes);
orgScoped.route("/changes", resourceChangeRoutes);
orgScoped.route("/status-incidents", statusIncidentRoutes);
orgScoped.route("/expiring", expiringRoutes);
orgScoped.route("/quotas", quotaRoutes);
orgScoped.route("/posture", postureRoutes);
orgScoped.route("/access-review", accessReviewRoutes);
orgScoped.route("/backups", backupRoutes);
orgScoped.route("/wallboard", wallboardRoutes);
orgScoped.route("/calendar", calendarRoutes);
orgScoped.route("/dns", dnsRoutes);
orgScoped.route("/environment-diff", environmentDiffRoutes);
orgScoped.route("/moment", momentRoutes);
orgScoped.route("/schedules", scheduleRoutes);
orgScoped.route("/leases", leaseRoutes);
orgScoped.route("/environments", environmentRoutes);
orgScoped.route("/probes", probeRoutes);
orgScoped.route("/incidents", incidentRoutes);
orgScoped.route("/status-pages", statusPageRoutes);
orgScoped.route("/ownership", ownershipRoutes);
orgScoped.route("/iac", iacRoutes);
orgScoped.route("/log-workspaces", logWorkspaceRoutes);
orgScoped.route("/associations", associationRoutes);
orgScoped.route("/dependency-graph", dependencyGraphRoutes);
orgScoped.route("/blast-radius", blastRadiusRoutes);
orgScoped.route("/ws-token", wsTokenRoutes);
orgScoped.route("/v1/storage", storageRoutes);
orgScoped.route("/v1/sftp", sftpRoutes);
orgScoped.route("/ssh-keys", sshKeyRoutes);
orgScoped.route("/ssh-host-keys", sshHostKeyRoutes);
orgScoped.route("/session-recordings", sessionRecordingRoutes);
orgScoped.route("/shared-consoles", sharedConsoleRoutes);
orgScoped.route("/access-requests", accessRequestRoutes);
orgScoped.route("/credential-hygiene", credentialHygieneRoutes);
orgScoped.route("/credits", creditRoutes);
orgScoped.route("/commitments", commitmentRoutes);
orgScoped.route("/network-flows", networkFlowRoutes);
orgScoped.route("/search", searchRoutes);
orgScoped.route("/connect", connectRoutes);
orgScoped.route("/ssh-tunnels", sshTunnelRoutes);
orgScoped.route("/ssh-fanout", sshFanoutRoutes);
orgScoped.route("/apps", appsRoutes);
orgScoped.route("/bastions", bastionRoutes);
orgScoped.route("/twilio", twilioRoutes);
orgScoped.route("/slack", slackRoutes);
orgScoped.route("/msteams", msteamsRoutes);
orgScoped.route("/jira", jiraRoutes);
orgScoped.route("/linear", linearRoutes);
orgScoped.route("/digest", digestRoutes);
orgScoped.route("/push", pushOrgRoutes);
// Registered before the rules router so `/alert-rules/noise` resolves here;
// every other `/alert-rules/*` path falls through to it.
orgScoped.route("/alert-rules", alertNoiseRoutes);
orgScoped.route("/alert-rules", alertRuleRoutes);

api.route("/api/org/:orgId", orgScoped);

export { api };
