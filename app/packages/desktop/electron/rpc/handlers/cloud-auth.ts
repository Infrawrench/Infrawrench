/** Cloud sign-in and the cloud org's SSH keys. */
import { Effect, Layer } from "effect";
import { CloudAuthRpcs } from "../../../shared/rpc/groups/cloud-auth";
import { CloudSshKeyRpcs } from "../../../shared/rpc/groups/cloud-ssh-keys";
import { CloudAuth } from "../../cloud-auth-flow";
import { CloudSshKeys } from "../../cloud-ssh-keys";

export const CloudAuthHandlers = CloudAuthRpcs.toLayer(
  Effect.gen(function* () {
    const auth = yield* CloudAuth;
    return CloudAuthRpcs.of({
      CloudAuthStart: () => auth.start,
      CloudAuthStatus: () => auth.status,
      CloudAuthOrgs: () => auth.orgs,
      CloudUrl: () => auth.url,
      CloudWsToken: ({ orgId }) => auth.wsToken(orgId),
      CloudAuthErrors: () => auth.failures,
    });
  }),
).pipe(Layer.provide(CloudAuth.layer));

export const CloudSshKeyHandlers = CloudSshKeyRpcs.toLayer(
  Effect.gen(function* () {
    const keys = yield* CloudSshKeys;
    return CloudSshKeyRpcs.of({
      CloudSshKeysList: ({ orgId }) => keys.list(orgId),
      CloudSshKeysCreate: ({ orgId, name }) => keys.create(orgId, name),
      CloudSshKeysDelete: ({ orgId, id }) => keys.remove(orgId, id),
    });
  }),
).pipe(Layer.provide(CloudSshKeys.layer));
