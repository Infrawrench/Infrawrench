import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { sessionMiddleware, orgMiddleware } from "./auth-middleware";
import { workos, clientId } from "../auth/workos";

// Public routes (no auth)
import { callbackRoutes } from "./routes/callback";
import { stripeWebhookRoutes } from "./routes/stripe-webhook";

// Auth routes (session-authed — me, sign-out, orgs)
import { authRoutes } from "./routes/auth";

// Unscoped session-authed routes (no org context needed)
import { orgManagementRoutes } from "./routes/orgs";
import { invitationAcceptRoutes } from "./routes/invitation-accept";

// Org-scoped session-authed routes
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
import { searchRoutes } from "./routes/search";
import { connectRoutes } from "./routes/connect";
import { sshTunnelRoutes } from "./routes/ssh-tunnels";

// API-key-authed routes (handle their own auth)
import { syncRoutes } from "./routes/sync";

const api = new Hono();

api.onError((err, c) => {
  if (err instanceof HTTPException) return err.getResponse();
  const message = err instanceof Error ? err.message : String(err);
  console.error("[api] uncaught error:", err);
  return c.json({ error: message }, 500);
});

api.route("/callback", callbackRoutes);
api.route("/api/v1/webhooks/stripe", stripeWebhookRoutes);

api.get("/api/auth/sign-in", async (c) => {
  const redirectUri = process.env["WORKOS_REDIRECT_URI"] ?? "http://localhost:3000/callback";
  const url = workos.userManagement.getAuthorizationUrl({
    provider: "authkit",
    clientId,
    redirectUri,
  });
  return c.redirect(url);
});

api.route("/api/v1/sync", syncRoutes);

const authed = new Hono();
authed.use("*", sessionMiddleware);

authed.route("/auth", authRoutes);
authed.route("/orgs", orgManagementRoutes);
authed.route("/invitations", invitationAcceptRoutes);

api.route("/api", authed);

const orgScoped = new Hono();
orgScoped.use("*", sessionMiddleware);
orgScoped.use("*", orgMiddleware);

orgScoped.route("/dashboards", dashboardRoutes);
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
orgScoped.route("/search", searchRoutes);
orgScoped.route("/connect", connectRoutes);
orgScoped.route("/ssh-tunnels", sshTunnelRoutes);

api.route("/api/org/:orgId", orgScoped);

export { api };
