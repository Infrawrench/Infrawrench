/**
 * Object storage transfers: `/api/org/:orgId/v1/storage`, the handlers.
 *
 * Every plugin client call runs inside `legacy`, so the client's own egress
 * scope (the SSRF guard) is entered inside the request's scopes. The zip of a
 * multi-key download is filled by work started inside those scopes before the
 * response is returned; the body's pulls only drain what it wrote.
 */
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { PassThrough } from "node:stream";
import archiver from "archiver";
import { Effect, Predicate } from "effect";
import { HttpServerResponse } from "effect/http";
import { HttpApiBuilder } from "effect/http-api";
import { attachmentDisposition } from "../../../lib/content-disposition";
import { getClientForAccount } from "../../../services/plugin-clients";
import { storageDrivers } from "../../../services/drivers";
import { buildPluginHostServices } from "../../../services/host-services";
import { makeDomain } from "../../domain";
import { badRequest, InternalServerError, notFound } from "../../errors";
import { fireAndForget, legacy, legacyTry } from "../../legacy";
import { OrgPrincipal } from "../../principal";
import { ok } from "../../schemas/common";
import { formFile, formString, readFormFields, webStream } from "../transfer-bodies";
import { StorageTransfersApi } from "./api";

/** Maximum number of keys accepted in a single bulk download. */
const MAX_BULK_KEYS = 100;

/** A non-guessable temp path under the OS tmpdir for a download. */
function tmpDownloadPath(key: string): string {
  return path.join(os.tmpdir(), `iw-download-${randomUUID()}-${path.basename(key)}`);
}

const messageOr = (error: unknown, fallback: string) =>
  error instanceof Error ? error.message : fallback;

/** The `keys` query parameter: a JSON array, or the 400 it was refused with. */
function parseKeys(raw: string): { readonly keys: unknown[] } | { readonly error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { error: "Invalid keys parameter" };
  }
  if (!Array.isArray(parsed)) return { error: "keys must be a JSON array of strings" };
  return { keys: parsed };
}

const StorageTransfersHandlers = HttpApiBuilder.group(
  StorageTransfersApi,
  "storageTransfers",
  (handlers) =>
    handlers
      .handleRaw("upload", ({ request }) =>
        Effect.gen(function* () {
          const { organizationId } = yield* OrgPrincipal;
          const form = yield* readFormFields(request);
          const accountId = formString(form, "accountId");
          const bucket = formString(form, "bucket");
          const key = formString(form, "key");
          const file = formFile(form, "file");
          if (!accountId || !bucket || !key || !file) {
            return yield* badRequest("Missing accountId, bucket, key, or file");
          }
          const ctx = yield* legacy(() => getClientForAccount(accountId, organizationId));
          if (!ctx) return yield* notFound("Account or plugin not found");
          const upload = ctx.client.uploadStorageObject;
          if (!upload) return yield* badRequest("Plugin does not support upload");
          yield* legacy(() => upload.call(ctx.client, bucket, key, file));
          return HttpServerResponse.jsonUnsafe(ok);
        }),
      )
      .handle("download", ({ query }) =>
        Effect.gen(function* () {
          const { organizationId } = yield* OrgPrincipal;
          const { accountId, bucket, keys: keysParam } = query;
          if (!accountId || !bucket || !keysParam) {
            return yield* badRequest("Missing accountId, bucket, or keys");
          }
          const parsed = parseKeys(keysParam);
          if ("error" in parsed) return yield* badRequest(parsed.error);
          // The route took the array as strings unchecked; an entry that is not
          // one (no client sends it) reaches the driver stringified.
          const keys = parsed.keys.map((k) => (Predicate.isString(k) ? k : String(k)));
          if (keys.length === 0) return yield* badRequest("No keys specified");
          if (keys.length > MAX_BULK_KEYS) {
            return yield* badRequest(`Too many keys (max ${MAX_BULK_KEYS})`);
          }

          const ctx = yield* legacy(() => getClientForAccount(accountId, organizationId));
          if (!ctx) return yield* notFound("Account or plugin not found");
          const getToken = ctx.client.getStorageAccessToken;
          if (!getToken) {
            return yield* badRequest("Plugin does not support storage access tokens");
          }
          const accessToken = yield* legacy(() => getToken.call(ctx.client));
          const storageDriver = storageDrivers.get(ctx.account.pluginId);
          if (!storageDriver) return yield* badRequest("No storage driver for this plugin");

          // Prefer the account's host HTTP bridge so bastion-bound accounts keep
          // grant + byte fetches on the tunnel. Drivers that don't need it ignore it.
          const hostServices = yield* legacy(() =>
            buildPluginHostServices(ctx.plugin.manifest, ctx.credentials, {
              bastionId: ctx.account.bastionId ?? null,
            }),
          );
          const downloadOpts = hostServices?.http ? { http: hostServices.http } : undefined;

          const [only] = keys;
          if (keys.length === 1 && only !== undefined) {
            const tmpPath = tmpDownloadPath(only);
            const data = yield* legacyTry(
              async () => {
                await storageDriver.downloadFile(bucket, only, accessToken, tmpPath, downloadOpts);
                const { readFile, unlink } = await import("node:fs/promises");
                const contents = await readFile(tmpPath);
                unlink(tmpPath).catch((err: unknown) => {
                  console.error(`[storage] tmp cleanup failed for ${tmpPath}:`, err);
                });
                return contents;
              },
              (error) => new InternalServerError({ error: messageOr(error, "Download failed") }),
            );
            return HttpServerResponse.raw(
              new Response(new Uint8Array(data), {
                headers: {
                  "Content-Type": "application/octet-stream",
                  "Content-Disposition": attachmentDisposition(path.basename(only)),
                  "Content-Length": String(data.length),
                },
              }),
            );
          }

          const passthrough = new PassThrough();
          const archive = archiver("zip", { zlib: { level: 6 } });
          archive.pipe(passthrough);
          // Started inside the request's scopes and not awaited: the body is the zip.
          yield* fireAndForget(async () => {
            try {
              for (const key of keys) {
                if (key.endsWith("/")) continue;
                const tmpPath = tmpDownloadPath(key);
                await storageDriver.downloadFile(bucket, key, accessToken, tmpPath, downloadOpts);
                archive.file(tmpPath, { name: key });
              }
              await archive.finalize();
            } catch {
              archive.abort();
            }
          });
          return HttpServerResponse.raw(
            new Response(webStream(passthrough), {
              headers: {
                "Content-Type": "application/zip",
                "Content-Disposition": attachmentDisposition(`download-${Date.now()}.zip`),
              },
            }),
          );
        }),
      ),
);

export const storageTransfersDomain = makeDomain(
  "storage-transfers",
  StorageTransfersApi,
  StorageTransfersHandlers,
);
