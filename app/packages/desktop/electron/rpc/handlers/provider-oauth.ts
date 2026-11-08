import { Effect, Layer } from "effect";
import { ProviderOAuthRpcs } from "../../../shared/rpc/groups/provider-oauth";
import { ProviderOAuth } from "../../provider-oauth/connect";

export const ProviderOAuthHandlers = ProviderOAuthRpcs.toLayer(
  Effect.gen(function* () {
    const oauth = yield* ProviderOAuth;
    return ProviderOAuthRpcs.of({
      ProviderOAuthLocalClients: () => oauth.localClients,
      ProviderOAuthConnect: (request) => oauth.connect(request),
      ProviderOAuthCancel: () => oauth.cancel,
      ProviderOAuthStatusChanges: () => oauth.statusChanges,
    });
  }),
).pipe(Layer.provide(ProviderOAuth.layer));
