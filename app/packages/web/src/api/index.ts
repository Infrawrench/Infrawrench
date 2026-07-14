import { Hono } from "hono";
import workflowRoutes from "./routes/workflows.js";
import agentRoutes from "./routes/agents.js";
import { HTTPException } from "hono/http-exception";
import { setCookie } from "hono/cookie";
import { randomBytes, randomUUID } from "node:crypto";
import { apiReference } from "@scalar/hono-api-reference";
import { sessionMiddleware, orgMiddleware, permissionsMiddleware } from "./auth-middleware";
import { workos, clientId } from "../auth/workos";
import { getOpenApiDocument } from "./openapi/index";
import { OAUTH_STATE_COOKIE } from "./oauth-state";

import { callbackRoutes } from "./routes/callback";
import { stripeWebhookRoutes } from "./routes/stripe-webhook";
import { workflowGitWebhook } from "./routes/workflows-git";
import { githubRoutes, githubSetupRoute } from "./routes/github";

import { authRoutes } from "./routes/auth";

import { orgManagementRoutes } from "./routes/orgs";
import { invitationAcceptRoutes } from "./routes/invitation-accept";

import { dashboardRoutes } from "./routes/dashboards";
import { accountRoutes } from "./routes/accounts";
import { apiKeyRoutes } from "./routes/api-keys";
import { teamRoutes } from "./routes/team";
import { billingRoutes } from "./routes/billing";
import { auditRoutes } from "./routes/audit";
import { connectionFeatureRoutes } from "./routes/connection-features";
import { resourceDetailRoutes } from "./routes/resource-detail";
import { associationRoutes } from "./routes/associations";
import { wsTokenRoutes } from "./routes/ws-token";
import { storageRoutes } from "./routes/storage";
import { sftpRoutes } from "./routes/sftp";
import { sshKeyRoutes } from "./routes/ssh-keys";
import { sshHostKeyRoutes } from "./routes/ssh-host-keys";
import { searchRoutes } from "./routes/search";
import { connectRoutes } from "./routes/connect";
import { sshTunnelRoutes } from "./routes/ssh-tunnels";
import { bastionRoutes } from "./routes/bastions";
import { twilioRoutes } from "./routes/twilio";

// API-key-authed; handles its own auth.
import { syncRoutes } from "./routes/sync";
import { chatRoutes } from "./routes/chat";

import { wellKnownRoutes } from "../mcp/well-known";

const api = new Hono();

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
api.route("/.well-known", wellKnownRoutes);

// Public — the spec describes the API surface, not private data.
api.get("/openapi.json", async (c) => c.json(await getOpenApiDocument()));
api.get(
  "/docs",
  apiReference({
    spec: { url: "/openapi.json" },
    pageTitle: "Infrawrench API",
    theme: "default",
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
    maxAge: 60 * 5,
  });
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

const authed = new Hono();
authed.use("*", sessionMiddleware);

authed.route("/auth", authRoutes);
authed.route("/orgs", orgManagementRoutes);
authed.route("/invitations", invitationAcceptRoutes);

api.route("/api", authed);

const orgScoped = new Hono();
orgScoped.use("*", sessionMiddleware);
orgScoped.use("*", orgMiddleware);
orgScoped.use("*", permissionsMiddleware);

orgScoped.route("/dashboards", dashboardRoutes);
orgScoped.route("/workflows", workflowRoutes);
orgScoped.route("/agents", agentRoutes);
orgScoped.route("/github", githubRoutes);
orgScoped.route("/accounts", accountRoutes);
orgScoped.route("/api-keys", apiKeyRoutes);
orgScoped.route("/team", teamRoutes);
orgScoped.route("/billing", billingRoutes);
orgScoped.route("/audit-logs", auditRoutes);
orgScoped.route("/", connectionFeatureRoutes);
orgScoped.route("/resources", resourceDetailRoutes);
orgScoped.route("/associations", associationRoutes);
orgScoped.route("/ws-token", wsTokenRoutes);
orgScoped.route("/v1/storage", storageRoutes);
orgScoped.route("/v1/sftp", sftpRoutes);
orgScoped.route("/ssh-keys", sshKeyRoutes);
orgScoped.route("/ssh-host-keys", sshHostKeyRoutes);
orgScoped.route("/search", searchRoutes);
orgScoped.route("/connect", connectRoutes);
orgScoped.route("/ssh-tunnels", sshTunnelRoutes);
orgScoped.route("/bastions", bastionRoutes);
orgScoped.route("/twilio", twilioRoutes);

api.route("/api/org/:orgId", orgScoped);

export { api };
