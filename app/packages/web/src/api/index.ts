import { Hono } from "hono";
import { httpApiMiddleware, makeHttpApiHandler } from "../http/server";
import { DOMAINS } from "../http/domains";
import { MiddlewareLive } from "../http/middleware-live";
import {
  ObjectAccessDeniedError,
  ObjectNotVisibleError,
  SharingInputError,
} from "../services/object-sharing";
import { costVisibilityMiddleware } from "../auth/cost-visibility";
import { HTTPException } from "hono/http-exception";
import { randomUUID } from "node:crypto";
import {
  sessionMiddleware,
  orgMiddleware,
  permissionsMiddleware,
  apiKeyOrgMiddleware,
  agentOrgMiddleware,
  unlessApiKey,
} from "./auth-middleware";
import { securityHeaders } from "./security-headers";
import {
  GATEWAY_ONLY_HEADER,
  isGatewayOnlyError,
} from "@infrawrench/server-core/runtime/gateway-only";

import { billingRoutes } from "./routes/billing";

const api = new Hono();

// First middleware on the stack so every response below (including the ones
// `onError` synthesizes) carries the baseline headers. `prodApp` in server.ts
// mounts the same middleware for static and SPA responses.
api.use("*", securityHeaders());

// Every route already on HttpApi (`http/domains.ts`), ahead of the Hono routes
// below; a request no domain routes carries on down this stack untouched.
api.use("*", httpApiMiddleware(makeHttpApiHandler(DOMAINS, MiddlewareLive)));

api.onError((err, c) => {
  if (err instanceof HTTPException) return err.getResponse();
  // Object sharing (services/object-sharing.ts) throws from the services the
  // routes and tools share; an object below `viewer` is a 404 so its
  // existence does not leak, one the caller can see but not change a 403.
  if (err instanceof ObjectNotVisibleError) return c.json({ error: "Not found" }, 404);
  if (err instanceof ObjectAccessDeniedError) return c.json({ error: err.message }, 403);
  if (err instanceof SharingInputError) return c.json({ error: err.message }, 400);
  // Only possible on the edge, where Node-only libraries are stubs: the edge
  // router sees the header and replays the request on the Node gateway (see
  // `edge/worker.ts`). The body is what a client gets if it cannot.
  if (isGatewayOnlyError(err)) {
    c.header(GATEWAY_ONLY_HEADER, "1");
    return c.json({ error: "This request could not be completed here. Please try again." }, 503);
  }
  // In production we don't echo the message/stack: they leak schema, paths, secrets.
  const correlationId = randomUUID();
  console.error(`[api] uncaught error correlationId=${correlationId}:`, err);
  if (process.env["NODE_ENV"] === "production") {
    return c.json({ error: "Internal server error", correlationId }, 500);
  }
  const message = err instanceof Error ? err.message : String(err);
  return c.json({ error: message, correlationId }, 500);
});

// The WorkOS sign-in callback (`/callback`), the Slack OAuth hops
// (`/api/slack/oauth/*`), the provider OAuth callback
// (`/api/provider-oauth/:pluginId/callback`) and inbound Slack (slash commands,
// interactivity and the account-link landing) are HttpApi domains with no auth
// middleware: the sign-in cookies, a signed or sealed state and Slack's
// signature are their proof, and the two that need a person run the session
// check themselves (`http/domains/callback`, `slack-oauth`, `provider-oauth`,
// `slack-inbound`).
// The GitHub App setup callback (`/api/github/setup`), the Teams anomaly
// feedback page (`/api/anomaly-feedback`) and the alert-email unsubscribe
// pages are HttpApi domains with no auth middleware: the first two check the
// session themselves (bouncing through sign-in), the last takes an
// HMAC-signed token (`http/domains/github`, `anomaly-feedback-link`,
// `alert-email-unsubscribe`).
// The discovery documents at the domain root (`/.well-known/*` for MCP's
// OAuth discovery, `/auth.md` for agent registration) and the API's own docs
// (`/openapi.json`, `/docs`) are public HttpApi domains
// (`http/domains/discovery/`, `api-docs/`).

// The bearer-only `/api/v1` surface (desktop sync, whoami, the bulk and
// warehouse pricing data) is served by its HttpApi domains, which
// authenticate themselves (`http/bearer-caller.ts`).

// Chat (`http/domains/chat/`) and the push-up surfaces for servers outside
// Infrawrench, `POST /costs/rows` and `/pages` (`cost-ingest/`, `pages/`), are
// HttpApi domains that authenticate themselves (`http/org-request-caller.ts`):
// a session, a WorkOS bearer token or an `iwk_` key holding the route's scope,
// so the HttpApi router answers them ahead of the org tree below.

// Public status pages (`/api/status/:slug`) and iCalendar feeds
// (`/api/calendar/:token.ics`) are HttpApi groups with no auth middleware
// (`http/domains/status-pages/public.ts`, `calendar-feed`): the slug or the
// 32-byte token is the sole credential, and neither URL carries an org id.

// Agent registration and the claim ceremony (`/api/agent`, `/api/agent/claim`)
// and the agent link device flow and link surface (`/api/agent-links/requests`,
// `/api/agent-link`) are HttpApi domains outside every auth layer
// (`http/domains/agent-auth`, `agent-link-platform`): registration serves a
// caller with no credentials, so the rate limit in `trials/ceremony.ts` stands
// in for authentication on the only route that creates an organization with no
// person behind it; the person's halves run `SessionAuth`, and the linked
// platform presents its own `iwl_` credential.

// The session-only surface (`/api/auth`, `/api/profile`, `/api/orgs`,
// `/api/invitations`, `/api/admin`, `/api/push`) is served by HttpApi domains
// behind `SessionAuth`: user-scoped, a person only, each prefix guarded whole
// (`guardSessionPrefixes` in `http/prefix-guard.ts`) and none of it reaching
// the org tree. `authed-scope.test.ts` drives the real `api` to keep it so.

const orgScoped = new Hono();
// `iwk_` API keys authenticate here, alongside the session cookie and WorkOS
// bearer tokens the three middlewares below have always handled. The key path
// leaves the context in the identical shape (session, organizationId,
// permissions, role, elevations) so every route's `requirePermission` gate
// applies unchanged, over the key's scopes ∩ its owner's current role. Routes
// closed to keys whatever they hold are listed in `auth/api-key-route-policy.ts`.
//
// `unlessApiKey` is a pass-through for every other caller: when no key
// authenticated, each middleware runs exactly as it did before.
orgScoped.use("*", apiKeyOrgMiddleware);
// Agent credentials, same contract: pinned to one org, permissions already
// final, and a denial table of their own on top of the API-key one. Runs after
// the key middleware because the two never both match: a key is recognised by
// prefix and returns early here.
orgScoped.use("*", unlessApiKey(agentOrgMiddleware));
orgScoped.use("*", unlessApiKey(sessionMiddleware));
orgScoped.use("*", unlessApiKey(orgMiddleware));
orgScoped.use("*", unlessApiKey(permissionsMiddleware));
// Cost visibility scopes: runs for every principal (session, key, agent), last
// in the chain, so the whole handler executes inside the caller's scope and
// every ClickHouse cost read is narrowed by it. See auth/cost-visibility.ts.
orgScoped.use("*", costVisibilityMiddleware);

// Background export jobs: `/costs/exports/jobs…`.
// Saved inventory tables with per-resource cost, filed in the cost-report folders.
orgScoped.route("/billing", billingRoutes);

api.route("/api/org/:orgId", orgScoped);

export { api };
