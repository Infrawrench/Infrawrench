/**
 * The receiving end of the cross-replica relay, the handler.
 *
 * A session that lives in one pod's memory: today a Linux application
 * session, tomorrow the shared-console pty and the bastion registry that
 * `infra/k8s/web-ws-ingress.yaml` says are waiting on the same mechanism; can
 * only be driven by the pod holding it. `services/replica-relay.ts` leases the
 * session to that pod and forwards calls here; this route runs them.
 *
 * ## What authenticates this
 *
 * `INTERNAL_RELAY_SECRET`, compared in constant time, and nothing else. This is
 * a pod-to-pod endpoint: the caller is another replica of this same
 * deployment, and what it forwards is an operation it has *already*
 * authorised; `tools/linux-apps.ts` checked `resources:execute` before any of
 * this happened. So the secret is not standing in for a user's permissions; it
 * is what makes "this came from one of our pods" a fact rather than a hope.
 *
 * Two things keep that honest. The organization is part of the session key and
 * is re-applied to the resource lookup on this side (`resolveTarget` filters on
 * `organizationId`), so a forwarded call cannot reach across orgs however it is
 * shaped. And the relay only ever dials private pod addresses out of its own
 * table, so this endpoint is not a hop anyone outside the cluster can aim.
 *
 * It is served outside every auth middleware for the same reason the agent
 * ceremony is: its whole purpose is serving a caller that has no session. The
 * edge sends it to the gateway by path (`edge/gateway-routes.ts`).
 */
import { Effect, Schema } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { minLength } from "@infrawrench/ui/schemas";
import { runLocally, encodeOpResult, AppsHostError } from "../../../services/apps-headless";
import { verifyRelaySecret } from "../../../services/replica-relay";
import { makeDomain } from "../../domain";
import { BadRequest, Unauthorized, UnprocessableEntity } from "../../errors";
import { readJsonOr } from "../../json-body";
import { legacyTry } from "../../legacy";
import { respond } from "../../response";
import { InternalRelayApi } from "./api";

const NonEmpty = Schema.String.check(minLength(1));

/**
 * A forwarded call. `payload` keeps every field it arrives with (the
 * operation's own arguments: a window id, coordinates, text), beside the
 * session it names.
 */
const RelayCall = Schema.Struct({
  kind: Schema.Literal("linux-app"),
  key: NonEmpty,
  op: Schema.Literals([
    "listApps",
    "launch",
    "windows",
    "screenshot",
    "a11yTree",
    "click",
    "typeText",
    "pressKeys",
    "scroll",
    "closeWindow",
    "end",
  ]),
  payload: Schema.StructWithRest(
    Schema.Struct({
      organizationId: NonEmpty,
      resourceId: NonEmpty,
      userId: Schema.optionalKey(Schema.String),
      sshKeyId: Schema.optionalKey(Schema.String),
      username: Schema.optionalKey(Schema.String),
    }),
    [Schema.Record(Schema.String, Schema.Unknown)],
  ),
});

const InternalRelayHandlers = HttpApiBuilder.group(InternalRelayApi, "internalRelay", (handlers) =>
  handlers.handleRaw("relay", ({ request }) =>
    Effect.gen(function* () {
      // Checked before the body is read: this is the whole of the authentication.
      if (!verifyRelaySecret(request.headers["authorization"])) {
        return yield* new Unauthorized({ error: "Unauthorized" });
      }

      const body = yield* readJsonOr(request, null);
      const { key, op, payload } = yield* Schema.decodeUnknownEffect(RelayCall)(body).pipe(
        Effect.mapError(() => new BadRequest({ error: "Malformed relay call" })),
      );

      // The key is derived from the org and resource on the sending side; if the
      // two disagree, the lease this call was routed on is not the session it is
      // asking for, and running it would drive the wrong host.
      if (key !== `${payload.organizationId}:${payload.resourceId}`) {
        return yield* new BadRequest({ error: "Relay key does not match its payload" });
      }

      const ref = {
        organizationId: payload.organizationId,
        resourceId: payload.resourceId,
        ...(payload.userId ? { userId: payload.userId } : {}),
        ...(payload.sshKeyId ? { sshKeyId: payload.sshKeyId } : {}),
        ...(payload.username ? { username: payload.username } : {}),
      };

      const result = yield* legacyTry(
        async () => encodeOpResult(op, await runLocally(ref, op, payload)),
        (error) => {
          // A host-level failure is the answer, not a server fault: the forwarding
          // pod re-raises it to whoever asked, so it must arrive with its message
          // intact rather than as a 500 the caller cannot explain.
          if (error instanceof AppsHostError)
            return new UnprocessableEntity({ error: error.message });
          const message = error instanceof Error ? error.message : String(error);
          console.warn(`[relay] ${op} failed for ${key}:`, message);
          return new UnprocessableEntity({ error: message });
        },
      );
      return yield* respond(Schema.Unknown)(result);
    }),
  ),
);

export const internalRelayDomain = makeDomain(
  "internalRelay",
  InternalRelayApi,
  InternalRelayHandlers,
);
