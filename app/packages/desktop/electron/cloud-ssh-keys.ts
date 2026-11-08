/**
 * The cloud org's SSH keys, through the main process's signed-in session
 * (`shared/rpc/groups/cloud-ssh-keys.ts`).
 */
import { Context, Effect, Layer, Schema } from "effect";
import { CloudRequestError } from "../shared/rpc/errors";
import { CloudSshKey, GeneratedCloudSshKey } from "../shared/rpc/groups/cloud-ssh-keys";
import { cloudFetch } from "./cloud-data/shared";
import { cloudRequest } from "./cloud-request";

const CloudSshKeyList = Schema.NullOr(Schema.mutable(Schema.Array(CloudSshKey)));

export class CloudSshKeys extends Context.Service<
  CloudSshKeys,
  {
    readonly list: (orgId: string) => Effect.Effect<CloudSshKey[], CloudRequestError>;
    readonly create: (
      orgId: string,
      name: string,
    ) => Effect.Effect<GeneratedCloudSshKey, CloudRequestError>;
    readonly remove: (orgId: string, id: string) => Effect.Effect<void, CloudRequestError>;
  }
>()("infrawrench/desktop/CloudSshKeys") {
  static readonly layer = Layer.succeed(CloudSshKeys)(
    CloudSshKeys.of({
      list: (orgId) =>
        cloudRequest(CloudSshKeyList, orgId, "/ssh-keys").pipe(Effect.map((keys) => keys ?? [])),
      create: (orgId, name) =>
        cloudRequest(GeneratedCloudSshKey, orgId, "/ssh-keys", {
          method: "POST",
          body: JSON.stringify({ name }),
        }),
      remove: (orgId, id) =>
        Effect.tryPromise({
          try: () =>
            cloudFetch<unknown>(orgId, `/ssh-keys/${encodeURIComponent(id)}`, {
              method: "DELETE",
            }),
          catch: CloudRequestError.fromCause,
        }).pipe(Effect.asVoid),
    }),
  );
}
