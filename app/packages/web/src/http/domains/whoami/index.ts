/**
 * `GET /api/v1/whoami`, the handler. Accepts every credential
 * `authenticateApiRequest` does (`iwk_` API keys, `iwa_` agent credentials,
 * WorkOS access tokens for a person or an agent) and needs no scope, because
 * it reveals nothing the holder could not already learn by using the
 * credential.
 */
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { asBearerCaller } from "../../bearer-caller";
import { makeDomain } from "../../domain";
import { respond } from "../../response";
import { Whoami, WhoamiApi } from "./api";

const WhoamiHandlers = HttpApiBuilder.group(WhoamiApi, "whoami", (handlers) =>
  handlers.handle("get", () =>
    asBearerCaller((auth) => {
      const principal = auth.agentRegistrationId ? "agent" : auth.apiKeyId ? "api_key" : "user";
      return respond(Whoami)({
        userId: auth.userId,
        organizationId: auth.organizationId,
        principal,
      });
    }),
  ),
);

export const whoamiDomain = makeDomain("whoami", WhoamiApi, WhoamiHandlers);
