import { Hono } from "hono";
import { sessionMiddleware } from "./auth-middleware";
import { workos, clientId } from "../auth/workos";

// Public routes (no auth)
import { callbackRoutes } from "./routes/callback";
import { stripeWebhookRoutes } from "./routes/stripe-webhook";

// Auth routes (session-authed — me, sign-out)
import { authRoutes } from "./routes/auth";

// Session-authed routes
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

// API-key-authed routes (handle their own auth)
import { syncRoutes } from "./routes/sync";

const api = new Hono();

// ── Public routes (no auth middleware) ──────────────────────────────────────
api.route("/callback", callbackRoutes);
api.route("/api/v1/webhooks/stripe", stripeWebhookRoutes);

// ── Auth routes — sign-in is public (no session middleware) ───────────────
api.get("/api/auth/sign-in", async (c) => {
  const redirectUri =
    process.env["WORKOS_REDIRECT_URI"] ?? "http://localhost:3000/callback";
  const url = workos.userManagement.getAuthorizationUrl({
    provider: "authkit",
    clientId,
    redirectUri,
  });
  return c.redirect(url);
});

// ── API-key-authed routes (handle their own auth internally) ────────────────
api.route("/api/v1/sync", syncRoutes);

// ── Session-authed routes ──────────────────────────────────────────────────
const authed = new Hono();
authed.use("*", sessionMiddleware);

authed.route("/auth", authRoutes);
authed.route("/dashboards", dashboardRoutes);
authed.route("/accounts", accountRoutes);
authed.route("/api-keys", apiKeyRoutes);
authed.route("/team", teamRoutes);
authed.route("/billing", billingRoutes);
authed.route("/audit-logs", auditRoutes);
authed.route("/", connectionFeatureRoutes);
authed.route("/resources", resourceDetailRoutes);
authed.route("/associations", associationRoutes);
authed.route("/ws-token", wsTokenRoutes);
authed.route("/v1/storage", storageRoutes);
authed.route("/v1/sftp", sftpRoutes);
authed.route("/ssh-keys", sshKeyRoutes);
authed.route("/search", searchRoutes);

api.route("/api", authed);

export { api };
