/**
 * "Install service…" on an SSH target in cloud mode: typed calls to the
 * resources domain's `ssh-install` endpoints over the cloud transport
 * (`./cloud-client.ts`). The local-mode half is `./ssh-install.ts`.
 *
 * The install connects to the host from the cloud, so a first contact answers
 * 409 `ssh_host_key_trust_required`; the transport asks about the key, trusts
 * it on accept and sends the request once more, as it does for every route.
 */
import type {
  SshInstallAccount,
  SshInstallInput,
  SshInstallResult,
} from "@infrawrench/plugin-base";
import { Effect, Option, Predicate, Schema } from "effect";
import { cloudClient, CloudResponseError } from "./cloud-client";
import { definedFields } from "./cloud-payload";
import { runRpc } from "./rpc/client";

const resources = () => cloudClient("resources").resources;

/** The service accounts that can enroll an SSH server. */
export function listCloudSshInstallAccounts(orgId: string): Promise<SshInstallAccount[]> {
  return runRpc(resources().sshInstallAccounts({ params: { orgId } }));
}

const decodeJsonBody = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

/**
 * The sentence the install dialog shows for a refused install: the server's
 * `message`, else its `error`, else the body as text, else
 * "SSH installation failed (<status>)." for an empty one.
 */
function installFailureMessage(status: number, body: string): string {
  const parsed = Option.getOrUndefined(decodeJsonBody(body));
  const detail =
    Predicate.hasProperty(parsed, "message") && parsed.message != null
      ? parsed.message
      : Predicate.hasProperty(parsed, "error") && parsed.error != null
        ? parsed.error
        : undefined;
  const message = detail === undefined ? body : String(detail);
  return message || `SSH installation failed (${status}).`;
}

export function runCloudSshInstall(
  orgId: string,
  body: SshInstallInput,
): Promise<SshInstallResult> {
  return runRpc(
    resources()
      .sshInstall({ params: { orgId }, payload: definedFields(body) })
      .pipe(
        Effect.mapError((error) =>
          error instanceof CloudResponseError
            ? new CloudResponseError({
                message: installFailureMessage(error.status, error.body),
                status: error.status,
                body: error.body,
              })
            : error,
        ),
      ),
  );
}
