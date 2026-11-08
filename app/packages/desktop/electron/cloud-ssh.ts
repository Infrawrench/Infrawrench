/**
 * Cloud SSH operations the renderer cannot make through `CloudHttp`
 * (`shared/rpc/groups/cloud-ssh.ts`): an SFTP upload as a multipart form, an
 * SFTP download streamed to disk, and the host-key prompt on its own. Each
 * rides the cloud transport's session and host-key prompt
 * (`sendCloudRaw`, `promptAndTrustHostKey` in `cloud-transport.ts`), so the
 * 401 refresh and the 409 prompt-and-retry are the transport's, not copies.
 *
 * A download is written beside its destination under a temporary name and
 * renamed into place once complete, so an interrupted or failed one leaves no
 * partial file and never clobbers a file of the same name.
 */
import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { Context, Effect, Exit, Layer, Option } from "effect";
import type { SftpUploadForm } from "@infrawrench/api-contract";
import { CloudRequestError } from "../shared/rpc/errors";
import type {
  CloudSftpDownloadInput,
  CloudSftpUploadInput,
  CloudSshHostKeyTrustInput,
} from "../shared/rpc/groups/cloud-ssh";
import { promptAndTrustHostKey, sendCloudRaw } from "./cloud-transport";
import { resolveBlessedDownloadPath } from "./main-utils";

const sftpPath = (orgId: string, rest: string) =>
  `/api/org/${encodeURIComponent(orgId)}/v1/sftp/${rest}`;

/**
 * The upload form's text fields, typed against the contract's `SftpUploadForm`
 * so a renamed field fails the typecheck. Empty overrides are left out, as
 * the server reads an empty field as a value.
 */
const uploadFields = (
  input: CloudSftpUploadInput,
): Omit<typeof SftpUploadForm.Encoded, "file"> => ({
  accountId: input.accountId,
  remotePath: input.remotePath,
  ...(input.sshKeyId ? { sshKeyId: input.sshKeyId } : {}),
  ...(input.sshHost ? { sshHost: input.sshHost } : {}),
  ...(input.sshUsername ? { sshUsername: input.sshUsername } : {}),
});

/** The body of a refusal, for its sentence; empty when it cannot be read. */
const bodyText = (response: Response) => Effect.promise(() => response.text().catch(() => ""));

/**
 * Write `body` to a temporary file beside `localPath` and rename it into
 * place. Whatever stops it short (a failure, the caller interrupted) aborts
 * the copy, waits for it to stop writing, and removes the temporary file.
 */
const saveBody = (body: Response["body"], localPath: string) => {
  const partial = join(dirname(localPath), `.${basename(localPath)}.${randomUUID()}.part`);
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      const controller = new AbortController();
      const done = body
        ? pipeline(Readable.fromWeb(body), createWriteStream(partial), {
            signal: controller.signal,
          })
        : pipeline(Readable.from([]), createWriteStream(partial));
      return { controller, done };
    }),
    ({ done }) =>
      Effect.tryPromise({
        try: async () => {
          await done;
          await rename(partial, localPath);
        },
        catch: CloudRequestError.fromCause,
      }),
    ({ controller, done }, exit) =>
      Exit.isSuccess(exit)
        ? Effect.void
        : Effect.promise(async () => {
            controller.abort();
            await done.catch(() => undefined);
            await rm(partial, { force: true });
          }),
  );
};

export class CloudSsh extends Context.Service<
  CloudSsh,
  {
    readonly upload: (input: CloudSftpUploadInput) => Effect.Effect<void, CloudRequestError>;
    readonly download: (input: CloudSftpDownloadInput) => Effect.Effect<void, CloudRequestError>;
    readonly trustHostKey: (
      input: CloudSshHostKeyTrustInput,
    ) => Effect.Effect<boolean, CloudRequestError>;
  }
>()("infrawrench/desktop/CloudSsh") {
  static readonly layer = Layer.succeed(CloudSsh)(
    CloudSsh.of({
      upload: Effect.fn("CloudSsh.upload")(function* (input) {
        const filename = input.filename ?? input.remotePath.split("/").pop() ?? "upload";
        const response = yield* sendCloudRaw(sftpPath(input.orgId, "upload"), () => {
          const form = new FormData();
          for (const [name, value] of Object.entries(uploadFields(input))) form.append(name, value);
          form.append("file", new Blob([new Uint8Array(input.data)]), filename);
          return { method: "POST", body: form };
        });
        if (!response.ok) {
          return yield* new CloudRequestError({
            message: `Upload failed: ${response.status} ${yield* bodyText(response)}`,
          });
        }
      }),

      download: Effect.fn("CloudSsh.download")(function* (input) {
        // Before fetching: the destination must sit inside a folder the user
        // picked, and the relative path comes from remote names.
        const localPath = yield* Effect.tryPromise({
          try: () => resolveBlessedDownloadPath(input.destFolder, input.relativePath),
          catch: CloudRequestError.fromCause,
        });
        const query = new URLSearchParams({
          accountId: input.accountId,
          paths: JSON.stringify([input.remotePath]),
          ...(input.sshKeyId ? { sshKeyId: input.sshKeyId } : {}),
          ...(input.sshHost ? { sshHost: input.sshHost } : {}),
          ...(input.sshUsername ? { sshUsername: input.sshUsername } : {}),
        });
        const response = yield* sendCloudRaw(sftpPath(input.orgId, `download?${query}`), () => ({
          method: "GET",
        }));
        if (!response.ok) {
          return yield* new CloudRequestError({
            message: `Download failed: ${response.status} ${yield* bodyText(response)}`,
          });
        }
        yield* Effect.tryPromise({
          try: () => mkdir(dirname(localPath), { recursive: true }),
          catch: CloudRequestError.fromCause,
        });
        yield* saveBody(response.body, localPath);
      }),

      trustHostKey: Effect.fn("CloudSsh.trustHostKey")(function* (input) {
        const trusted = yield* promptAndTrustHostKey(encodeURIComponent(input.orgId), input);
        return Option.isSome(trusted) && trusted.value.ok;
      }),
    }),
  );
}
