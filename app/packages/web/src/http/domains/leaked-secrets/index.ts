/**
 * Leaked credentials: `/api/org/:orgId/leaked-secrets`, the handlers. The
 * server half lives in `server-core/src/leaked-secrets/`. Every action is
 * audited, never with the value: only how it was rotated.
 */
import { Effect, Predicate } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import {
  LEAKED_SECRET_STATUSES,
  type LeakDismissReason,
  type LeakedSecretStatus,
} from "@infrawrench/client-core";
import {
  LeakedSecretError,
  dismissLeak,
  markLeakRotated,
  reopenLeak,
  rotateLeak,
} from "@infrawrench/server-core/leaked-secrets/actions";
import { listLeakedSecrets } from "@infrawrench/server-core/leaked-secrets/store";
import { scanOrgLeakedSecretsNow } from "@infrawrench/server-core/leaked-secrets/scan";
import { logAudit } from "../../../services/audit";
import { makeDomain } from "../../domain";
import { badRequest, BadRequest, Conflict, HttpFailure, NotFound } from "../../errors";
import { fireAndForget, legacy, legacyTry } from "../../legacy";
import { inputRefusal, invalidBody, readObjectBody } from "../../object-body";
import { OrgPrincipal } from "../../principal";
import { respond } from "../../response";
import {
  LeakedSecretList,
  LeakedSecretResponse,
  LeakedSecretScanResult,
  LeakedSecretsApi,
} from "./api";

const DISMISS_REASONS: readonly LeakDismissReason[] = [
  "false-positive",
  "wont-fix",
  "used-in-tests",
];

const isLeakStatus = (value: string): value is LeakedSecretStatus =>
  LEAKED_SECRET_STATUSES.some((status) => status === value);

const isDismissReason = (value: unknown): value is LeakDismissReason =>
  DISMISS_REASONS.some((reason) => reason === value);

/** `undefined` when absent, `null` when present but not a boolean. */
function optionalBool(v: unknown): boolean | undefined | null {
  if (v === undefined) return undefined;
  return Predicate.isBoolean(v) ? v : null;
}

/**
 * An action's refusal answers with the status it carries, as the route's
 * `fail` did: 400/404/409 as the declared errors, a 502 (the provider failed)
 * as itself.
 */
const leakCall = <A>(
  fn: () => PromiseLike<A>,
): Effect.Effect<A, BadRequest | NotFound | Conflict> =>
  legacyTry(fn, (error) => {
    if (!(error instanceof LeakedSecretError)) return undefined;
    if (error.status === 502) return undefined;
    return inputRefusal({ status: error.status, message: error.message });
  }).pipe(
    Effect.catchDefect((defect) =>
      Effect.die(
        defect instanceof LeakedSecretError
          ? new HttpFailure(defect.status, { error: defect.message })
          : defect,
      ),
    ),
  );

const actor = Effect.gen(function* () {
  const { session } = yield* OrgPrincipal;
  return { userId: session.userId ?? null, userLabel: session.email ?? null };
});

const audit = (action: string, leak: { id: string; tokenType: string }, extra = {}) =>
  Effect.gen(function* () {
    const { organizationId, session } = yield* OrgPrincipal;
    yield* fireAndForget(() =>
      logAudit({
        organizationId,
        userId: session.userId ?? null,
        action: `leaked_secret.${action}`,
        entityType: "leaked-secret",
        entityId: leak.id,
        metadata: { tokenType: leak.tokenType, ...extra },
      }),
    );
  });

const LeakedSecretsHandlers = HttpApiBuilder.group(LeakedSecretsApi, "leakedSecrets", (handlers) =>
  handlers
    .handle("list", ({ query }) =>
      Effect.gen(function* () {
        const { status, accountId } = query;
        if (status && !isLeakStatus(status)) return yield* badRequest("Unknown status");
        const { organizationId } = yield* OrgPrincipal;
        const list = yield* legacy(() =>
          listLeakedSecrets(organizationId, {
            ...(status && isLeakStatus(status) ? { status } : {}),
            ...(accountId ? { accountId } : {}),
          }),
        );
        return yield* respond(LeakedSecretList)(list);
      }),
    )
    .handle("scan", () =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const result = yield* legacy(() => scanOrgLeakedSecretsNow(organizationId));
        return yield* respond(LeakedSecretScanResult)(result);
      }),
    )
    .handleRaw("rotate", ({ params, request }) =>
      Effect.gen(function* () {
        const read = yield* readObjectBody(request);
        if (!read.ok) return yield* invalidBody(read.error);
        const value = read.body["value"];
        if (value !== undefined && !Predicate.isString(value)) {
          return yield* badRequest("value must be a string");
        }
        const resolveUpstream = optionalBool(read.body["resolveUpstream"]);
        if (resolveUpstream === null) return yield* badRequest("resolveUpstream must be a boolean");
        const { organizationId } = yield* OrgPrincipal;
        const by = yield* actor;
        const leak = yield* leakCall(() =>
          rotateLeak(organizationId, params.id, { value, resolveUpstream }, by),
        );
        // Never the value: only how it was rotated.
        yield* audit("rotated", leak, { method: leak.rotationMethod, matchKind: leak.matchKind });
        return yield* respond(LeakedSecretResponse)({ leak });
      }),
    )
    .handleRaw("markRotated", ({ params, request }) =>
      Effect.gen(function* () {
        const read = yield* readObjectBody(request);
        if (!read.ok) return yield* invalidBody(read.error);
        const resolveUpstream = optionalBool(read.body["resolveUpstream"]);
        if (resolveUpstream === null) return yield* badRequest("resolveUpstream must be a boolean");
        const { organizationId } = yield* OrgPrincipal;
        const by = yield* actor;
        const leak = yield* leakCall(() =>
          markLeakRotated(organizationId, params.id, { resolveUpstream }, by),
        );
        yield* audit("rotated", leak, { method: "manual" });
        return yield* respond(LeakedSecretResponse)({ leak });
      }),
    )
    .handleRaw("dismiss", ({ params, request }) =>
      Effect.gen(function* () {
        const read = yield* readObjectBody(request);
        if (!read.ok) return yield* invalidBody(read.error);
        const reason = read.body["reason"];
        if (!Predicate.isString(reason) || !isDismissReason(reason)) {
          return yield* badRequest("reason must be false-positive, wont-fix or used-in-tests");
        }
        const comment = read.body["comment"];
        if (comment !== undefined && !Predicate.isString(comment)) {
          return yield* badRequest("comment must be a string");
        }
        const resolveUpstream = optionalBool(read.body["resolveUpstream"]);
        if (resolveUpstream === null) return yield* badRequest("resolveUpstream must be a boolean");
        const { organizationId } = yield* OrgPrincipal;
        const by = yield* actor;
        const leak = yield* leakCall(() =>
          dismissLeak(organizationId, params.id, { reason, comment, resolveUpstream }, by),
        );
        yield* audit("dismissed", leak, { reason });
        return yield* respond(LeakedSecretResponse)({ leak });
      }),
    )
    .handle("reopen", ({ params }) =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const leak = yield* leakCall(() => reopenLeak(organizationId, params.id));
        yield* audit("reopened", leak);
        return yield* respond(LeakedSecretResponse)({ leak });
      }),
    ),
);

export const leakedSecretsDomain = makeDomain(
  "leakedSecrets",
  LeakedSecretsApi,
  LeakedSecretsHandlers,
);
