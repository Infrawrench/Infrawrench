/**
 * Agent links from the platform's side, the handlers.
 *
 * The domain logic is `server-core/agent-links/links.ts`; these are the wire
 * contract and the gates in front of it, sentence for sentence what the Hono
 * routes answered. An `AgentLinkError` is sent as `{ error, code?, ...details }`
 * with the status it carries; anything else is the defect the API renders.
 *
 * The person's half runs behind {@link SessionAuth} (the group's middleware,
 * only on its three paths, as the Hono router's per-path `use` was), and the
 * link's own surface authenticates its `iwl_` credential in each handler and,
 * through {@link guardPrefixes}, on every other path under `/api/agent-link`,
 * as the router's `use("*", linkAuth)` did.
 */
import { Effect, Layer, Predicate, Schema } from "effect";
import { HttpServerRequest } from "effect/http";
import { HttpApiBuilder } from "effect/http-api";
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
import {
  AgentLinkInfo,
  AgentLinkLookup,
  AgentLinkPlatformApi,
  AgentLinkPoll,
  AgentLinkRequestStarted,
  Ok,
  ok,
  PlatformAgent,
  PlatformAgentEnvelope,
  PlatformAgentWithCredential,
} from "@infrawrench/api-contract";
import { logAudit } from "../../../services/audit";
import { buildLinkInfo, serializeAgent, unknownProviders } from "../../../services/agent-links";
import { rawRequest } from "../../caller-auth";
import { makeDomain } from "../../domain";
import { HttpFailure } from "../../errors";
import { readJsonOr } from "../../request-body";
import { fireAndForget, legacy, legacyTry } from "../../legacy";
import { failureResponse, json } from "../../middleware";
import { guardPrefixes } from "../../prefix-guard";
import { SessionPrincipal } from "../../principal";
import { respond } from "../../response";
import { clientIp, publicBaseUrl } from "../agent-auth/request-origin";
import { answeringFailures, requestHeader } from "../raw-responses";

/** An {@link AgentLinkError} as the contract's error body. */
const linkRefusal = (e: unknown): HttpFailure | undefined =>
  e instanceof AgentLinkError
    ? new HttpFailure(e.status, {
        error: e.message,
        ...(e.code ? { code: e.code } : {}),
        ...(e.details ?? {}),
      })
    : undefined;

/** `legacy`, answering an {@link AgentLinkError} as the contract's error body. */
const linkCall = <A>(fn: () => Promise<A>) => legacyTry(fn, linkRefusal);

/** The body as an object, or `{}`: what the routes' `readJson` gave them. */
const objectBody = (request: HttpServerRequest.HttpServerRequest) =>
  Effect.map(readJsonOr(request, null), (body): { readonly [key: string]: unknown } =>
    Predicate.isObject(body) && !Array.isArray(body) ? body : {},
  );

function boundedString(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length >= 1 && trimmed.length <= max ? trimmed : null;
}

const stringOr = (value: unknown, fallback: string) =>
  typeof value === "string" ? value : fallback;

// ─── The device flow ────────────────────────────────────────────────────────

const RequestHandlers = HttpApiBuilder.group(
  AgentLinkPlatformApi,
  "agentLinkRequests",
  (handlers) =>
    handlers
      /** A platform asks to be linked. */
      .handleRaw("start", ({ request }) =>
        answeringFailures(
          Effect.gen(function* () {
            const raw = yield* rawRequest;
            const body = yield* objectBody(request);
            const platform = stringOr(body["platform"], "");
            if (!PLATFORM_SLUG.test(platform)) {
              return json(
                { error: "`platform` must match [a-z0-9-]{1,40}.", code: "invalid_platform" },
                400,
              );
            }
            const label = boundedString(body["label"], LABEL_MAX);
            if (!label) {
              return json({ error: `\`label\` must be 1 to ${LABEL_MAX} characters.` }, 400);
            }
            const requested = body["requestedScopes"];
            if (requested !== undefined && !Array.isArray(requested)) {
              return json(
                { error: "`requestedScopes` must be an array of permission strings." },
                400,
              );
            }
            // Pre-ticks only, so an unknown string is dropped rather than refused: a
            // platform built against a newer catalog should still be able to link.
            const requestedScopes = [
              ...new Set(
                (Array.isArray(requested) ? requested : []).filter(
                  (s): s is string => typeof s === "string" && AGENT_SCOPES.includes(s),
                ),
              ),
            ];

            const started = yield* linkCall(() =>
              createLinkRequest({
                platform,
                label,
                requestedScopes,
                ip: clientIp(requestHeader(request, "x-forwarded-for")),
              }),
            );
            const base = publicBaseUrl(raw.url, requestHeader(request, "x-forwarded-proto"));
            return yield* respond(AgentLinkRequestStarted, { status: 201 })({
              deviceCode: started.deviceCode,
              userCode: started.userCode,
              verificationUrl: `${base}/link-agents`,
              verificationUrlComplete: `${base}/link-agents?code=${started.userCode}`,
              expiresIn: Math.round(LINK_REQUEST_TTL_MS / 1000),
              interval: LINK_POLL_INTERVAL_S,
            });
          }),
        ),
      )
      /** The platform polls. */
      .handleRaw("token", ({ request }) =>
        Effect.gen(function* () {
          const body = yield* objectBody(request);
          const deviceCode = stringOr(body["deviceCode"], "");
          if (!deviceCode) return json({ error: "`deviceCode` is required." }, 400);

          const result = yield* legacy(() => pollLinkRequest(deviceCode));
          if (result.status === "slow_down") return json({ error: "slow_down" }, 429);
          if (result.status !== "approved") {
            return yield* respond(AgentLinkPoll)({ status: result.status });
          }

          const link = yield* legacy(() => resolveLinkCredential(result.credential));
          if (!link) return yield* respond(AgentLinkPoll)({ status: "expired" });
          yield* fireAndForget(() =>
            logAudit({
              organizationId: link.organizationId,
              userId: link.approvedByUserId ?? undefined,
              action: "agent_link.create",
              entityType: "agent_link",
              entityId: link.id,
              metadata: { platform: link.platform, label: link.label, scopes: link.scopes },
            }),
          );
          const info = yield* legacy(() => buildLinkInfo(link));
          return yield* respond(AgentLinkPoll)({
            status: "approved",
            credential: result.credential,
            link: info,
          });
        }),
      ),
);

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

const throttled = () =>
  json({ error: "Too many attempts. Wait a few minutes and try again." }, 429);

const ApprovalHandlers = HttpApiBuilder.group(
  AgentLinkPlatformApi,
  "agentLinkApproval",
  (handlers) =>
    handlers
      /**
       * What the approval page shows. A POST with the code in the body, never
       * a query string: the code is a live bearer secret, and a URL lands in
       * history, `Referer` and access logs.
       */
      .handleRaw("lookup", ({ request }) =>
        answeringFailures(
          Effect.gen(function* () {
            const session = yield* SessionPrincipal;
            if (tooManyAttempts(session.userId)) return throttled();
            const body = yield* objectBody(request);
            const code = stringOr(body["code"], "");
            if (!code) return json({ error: "Enter the code the platform showed you." }, 400);

            const lookup = yield* linkCall(async () => {
              const linkRequest = await lookupLinkRequest(code);
              const { listUserOrganizations } = await import("../../../auth/users");
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
                  grantableScopes: canApprove
                    ? AGENT_SCOPES.filter((s) => grantable.includes(s))
                    : [],
                });
              }
              return {
                platform: linkRequest.platform,
                label: linkRequest.label,
                requestedScopes: linkRequest.requestedScopes,
                expiresAt: linkRequest.expiresAt.toISOString(),
                organizations,
              };
            });
            return yield* respond(AgentLinkLookup)(lookup);
          }),
        ),
      )
      .handleRaw("approve", ({ request }) =>
        answeringFailures(
          Effect.gen(function* () {
            const session = yield* SessionPrincipal;
            if (tooManyAttempts(session.userId)) return throttled();
            const body = yield* objectBody(request);
            const code = stringOr(body["code"], "");
            const organizationId = stringOr(body["organizationId"], "");
            const scopes = body["scopes"];
            if (!code || !organizationId) {
              return json({ error: "`code` and `organizationId` are required." }, 400);
            }
            if (
              !Array.isArray(scopes) ||
              scopes.length === 0 ||
              !scopes.every(Predicate.isString)
            ) {
              return json({ error: "Choose at least one permission for this link." }, 400);
            }

            const outcome = yield* linkCall(async () => {
              const linkRequest = await lookupLinkRequest(code);
              // Elevation excluded, as everywhere an unattended principal is scored: a
              // break-glass grant must not become the ceiling of a standing link.
              const grantable = await grantablePermissions(organizationId, session.userId);
              if (!grantable.includes("team:invite")) {
                return new HttpFailure(403, {
                  error:
                    "You need permission to invite people in that organization to link a platform.",
                });
              }
              const unique = [...new Set(scopes)];
              const notAllowed = unique.filter(
                (s) => !AGENT_SCOPES.includes(s) || !grantable.includes(s),
              );
              if (notAllowed.length > 0) {
                return new HttpFailure(400, {
                  error: `You cannot grant: ${notAllowed.join(", ")}`,
                  code: "scope_not_allowed",
                  scopes: notAllowed,
                });
              }
              await approveLinkRequest({
                requestId: linkRequest.id,
                organizationId,
                userId: session.userId,
                scopes: unique,
              });
              return { linkRequest, unique };
            });
            if (outcome instanceof HttpFailure) return failureResponse(outcome);
            const { linkRequest, unique } = outcome;
            yield* fireAndForget(() =>
              logAudit({
                organizationId,
                userId: session.userId,
                action: "agent_link.approve",
                entityType: "agent_link_request",
                entityId: linkRequest.id,
                metadata: {
                  platform: linkRequest.platform,
                  label: linkRequest.label,
                  scopes: unique,
                },
              }),
            );
            return yield* respond(Ok)(ok);
          }),
        ),
      )
      .handleRaw("deny", ({ request }) =>
        answeringFailures(
          Effect.gen(function* () {
            const session = yield* SessionPrincipal;
            if (tooManyAttempts(session.userId)) return throttled();
            const body = yield* objectBody(request);
            const code = stringOr(body["code"], "");
            if (!code) return json({ error: "`code` is required." }, 400);
            yield* linkCall(async () => {
              const linkRequest = await lookupLinkRequest(code);
              await denyLinkRequest(linkRequest.id, session.userId);
            });
            return yield* respond(Ok)(ok);
          }),
        ),
      ),
);

// ─── The link's own surface ─────────────────────────────────────────────────

/** The link an `iwl_` bearer credential belongs to, or the 401 the router has always sent. */
const linkCaller: Effect.Effect<AgentLinkRow, HttpFailure, HttpServerRequest.HttpServerRequest> =
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const header = requestHeader(request, "authorization");
    const token = header?.startsWith("Bearer ") ? header.slice(7) : "";
    const link = token ? yield* legacy(() => resolveLinkCredential(token)) : null;
    if (!link) return yield* Effect.fail(new HttpFailure(401, { error: "Unauthorized" }));
    yield* fireAndForget(() => keepAlive(touchLink(link.id)));
    return link;
  });

/** Authenticate the link, then `serve` as it; a refusal is the response. */
const asLink = <A, E, R>(serve: (link: AgentLinkRow) => Effect.Effect<A, E, R>) =>
  answeringFailures(Effect.flatMap(linkCaller, serve));

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

const agentNotFound = () => json({ error: "Agent not found" }, 404);

const LinkHandlers = HttpApiBuilder.group(AgentLinkPlatformApi, "agentLink", (handlers) =>
  handlers
    .handleRaw("describe", () =>
      asLink((link) =>
        Effect.flatMap(
          legacy(() => buildLinkInfo(link)),
          (info) => respond(AgentLinkInfo)(info),
        ),
      ),
    )
    /** Unlink, revoking every agent the link made. */
    .handleRaw("unlink", () =>
      asLink((link) =>
        Effect.gen(function* () {
          yield* legacy(() => revokeLink(link.id));
          yield* fireAndForget(() =>
            logAudit({
              organizationId: link.organizationId,
              userId: link.approvedByUserId ?? undefined,
              action: "agent_link.revoke",
              entityType: "agent_link",
              entityId: link.id,
              metadata: { platform: link.platform, by: "platform" },
            }),
          );
          return yield* respond(Ok)(ok);
        }),
      ),
    )
    .handleRaw("agents", () =>
      asLink((link) =>
        Effect.flatMap(
          legacy(() => listLinkAgents(link.id)),
          (rows) => respond(Schema.Array(PlatformAgent))(rows.map(serializeAgent)),
        ),
      ),
    )
    .handleRaw("createAgent", ({ request }) =>
      asLink((link) =>
        Effect.gen(function* () {
          const body = yield* objectBody(request);
          const externalId = boundedString(body["externalId"], EXTERNAL_ID_MAX);
          if (!externalId) {
            return json(
              { error: `\`externalId\` must be 1 to ${EXTERNAL_ID_MAX} characters.` },
              400,
            );
          }
          const label = boundedString(body["label"], LABEL_MAX);
          if (!label) {
            return json({ error: `\`label\` must be 1 to ${LABEL_MAX} characters.` }, 400);
          }

          const { grant, created } = yield* linkCall(async () => {
            const grant = await checkedGrant(link, body["scopes"], body["providers"]);
            const created = await createPlatformAgent({
              link,
              externalId,
              label,
              scopes: grant.scopes,
              providers: grant.providers,
            });
            return { grant, created };
          });
          yield* fireAndForget(() =>
            logAudit({
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
            }),
          );
          return yield* respond(PlatformAgentWithCredential, { status: 201 })({
            agent: serializeAgent(created.agent),
            credential: created.credential,
          });
        }),
      ),
    )
    .handleRaw("updateAgent", ({ request, params }) =>
      asLink((link) =>
        Effect.gen(function* () {
          const existing = yield* legacy(() => getLinkAgent(link.id, params.id));
          if (!existing || existing.revokedAt) return agentNotFound();
          const body = yield* objectBody(request);

          let label: string | undefined;
          if (body["label"] !== undefined) {
            const parsed = boundedString(body["label"], LABEL_MAX);
            if (!parsed) {
              return json({ error: `\`label\` must be 1 to ${LABEL_MAX} characters.` }, 400);
            }
            label = parsed;
          }
          const patch = yield* linkCall(async () => {
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
            return patch;
          });
          yield* fireAndForget(() =>
            logAudit({
              organizationId: link.organizationId,
              userId: link.approvedByUserId ?? undefined,
              action: "agent.update",
              entityType: "agent_registration",
              entityId: existing.id,
              metadata: { linkId: link.id, by: "platform", ...patch },
            }),
          );
          const updated = yield* linkCall(() => getLinkAgent(link.id, existing.id));
          return yield* respond(PlatformAgentEnvelope)({
            agent: serializeAgent(updated ?? existing),
          });
        }),
      ),
    )
    .handleRaw("rotateAgent", ({ params }) =>
      asLink((link) =>
        Effect.gen(function* () {
          const existing = yield* legacy(() => getLinkAgent(link.id, params.id));
          if (!existing || existing.revokedAt) return agentNotFound();
          const rotated = yield* legacy(() => rotatePlatformAgent(existing.id));
          if (!rotated) return agentNotFound();
          yield* fireAndForget(() =>
            logAudit({
              organizationId: link.organizationId,
              userId: link.approvedByUserId ?? undefined,
              action: "agent.rotate",
              entityType: "agent_registration",
              entityId: existing.id,
              metadata: { linkId: link.id },
            }),
          );
          const updated = yield* legacy(() => getLinkAgent(link.id, existing.id));
          return yield* respond(PlatformAgentWithCredential)({
            agent: serializeAgent(updated ?? existing),
            credential: rotated.credential,
          });
        }),
      ),
    )
    /** Revoke, not delete. Idempotent. */
    .handleRaw("revokeAgent", ({ params }) =>
      asLink((link) =>
        Effect.gen(function* () {
          const existing = yield* legacy(() => getLinkAgent(link.id, params.id));
          if (!existing) return agentNotFound();
          const revoked = yield* legacy(() => revokePlatformAgent(existing.id));
          if (revoked) {
            yield* fireAndForget(() =>
              logAudit({
                organizationId: link.organizationId,
                userId: link.approvedByUserId ?? undefined,
                action: "agent.revoke",
                entityType: "agent_registration",
                entityId: existing.id,
                metadata: { linkId: link.id, by: "platform" },
              }),
            );
          }
          return yield* respond(Ok)(ok);
        }),
      ),
    ),
);

/**
 * The rest of `/api/agent-link`: a 401 without a live link credential, and
 * with one, on to the 404 nothing routes. Two registrations because the bare
 * prefix has GET and DELETE endpoints, which a `prefix/*` route for those
 * methods would collide with.
 */
const linkGuard = linkCaller.pipe(
  Effect.as(undefined),
  Effect.catch((failure) => Effect.succeed(failureResponse(failure))),
);

export const agentLinkPlatformDomain = guardPrefixes(
  guardPrefixes(
    makeDomain(
      "agentLinkPlatform",
      AgentLinkPlatformApi,
      Layer.mergeAll(RequestHandlers, ApprovalHandlers, LinkHandlers),
    ),
    ["/api/agent-link"],
    linkGuard,
    ["POST", "PUT", "PATCH", "OPTIONS"],
  ),
  ["/api/agent-link/:segment"],
  linkGuard,
  ["GET", "DELETE"],
);
