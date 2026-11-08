/**
 * WebSocket gateway tokens: `/api/org/:orgId/ws-token`, the handler.
 *
 * A key or agent mints a token that carries its own ceiling. Without it the
 * socket would resolve permissions from `userId` alone, which for a key is
 * its owner's whole role: see `services/ws-auth.ts`.
 */
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { WsTokenApi, WsTokenResponse } from "@infrawrench/api-contract";
import { createWsToken } from "../../../services/ws-tokens";
import { makeDomain } from "../../domain";
import { legacy } from "../../legacy";
import { OrgPrincipal } from "../../principal";
import { respond } from "../../response";

const WsTokenHandlers = HttpApiBuilder.group(WsTokenApi, "wsToken", (handlers) =>
  handlers.handle("create", () =>
    Effect.gen(function* () {
      const { organizationId, session, apiKey } = yield* OrgPrincipal;
      const token = yield* legacy(() =>
        Promise.resolve(
          createWsToken(
            session.userId,
            organizationId,
            apiKey
              ? {
                  scopes: apiKey.scopes,
                  ...(apiKey.agentRegistrationId
                    ? { agentRegistrationId: apiKey.agentRegistrationId }
                    : {}),
                }
              : undefined,
          ),
        ),
      );
      return yield* respond(WsTokenResponse)({ token });
    }),
  ),
);

export const wsTokenDomain = makeDomain("ws-token", WsTokenApi, WsTokenHandlers);
