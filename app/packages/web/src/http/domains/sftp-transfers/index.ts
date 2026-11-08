/**
 * SFTP transfers: `/api/org/:orgId/v1/sftp`, the handlers.
 *
 * Resolving the SSH config reads the account's plugin client, so it runs in
 * the same `legacy` call as the client lookup. A multi-file download fetches
 * the first file before answering, so a host-key refusal is still the 409
 * rather than a truncated zip; the rest are appended by work started inside
 * the request's scopes, and the body's pulls only drain the archive.
 */
import path from "node:path";
import { PassThrough } from "node:stream";
import archiver from "archiver";
import { Effect, Predicate } from "effect";
import { HttpServerResponse } from "effect/http";
import { HttpApiBuilder } from "effect/http-api";
import { safeRelativePathSegments } from "@infrawrench/client-core";
import {
  badRequest,
  InternalServerError,
  notFound,
  ok,
  SftpTransfersApi,
} from "@infrawrench/api-contract";
import { attachmentDisposition } from "../../../lib/content-disposition";
import { sftpDownloadToBuffer, sftpUpload } from "../../../services/sftp";
import { getClientForAccount } from "../../../services/plugin-clients";
import { resolveSshConfig } from "../../../services/ssh";
import { makeDomain } from "../../domain";
import { fireAndForget, legacy, legacyTry } from "../../legacy";
import { OrgPrincipal } from "../../principal";
import { hostKeyTrustRefusal } from "../ssh-host-key-trust";
import { formFile, formString, readFormFields } from "../../request-body";
import { webStream } from "../../response";

const MAX_BULK_PATHS = 100;

const messageOr = (error: unknown, fallback: string) =>
  error instanceof Error ? error.message : fallback;

/** A download's refusal: the 409 for an untrusted host key, otherwise the route's 500. */
const downloadRefusal = (error: unknown) =>
  hostKeyTrustRefusal(error) ??
  new InternalServerError({ error: messageOr(error, "Download failed") });

interface SshOverrides {
  readonly sshKeyId: string | undefined;
  readonly sshHost: string | undefined;
  readonly sshUsername: string | undefined;
}

/** The account's SSH config, or null when the account is not found. */
const accountSshConfig = (organizationId: string, accountId: string, overrides: SshOverrides) =>
  legacy(async () => {
    const ctx = await getClientForAccount(accountId, organizationId);
    if (!ctx) return null;
    return resolveSshConfig(ctx.client, organizationId, {
      ...(overrides.sshKeyId !== undefined ? { sshKeyId: overrides.sshKeyId } : {}),
      ...(overrides.sshHost !== undefined ? { sshHost: overrides.sshHost } : {}),
      ...(overrides.sshUsername !== undefined ? { sshUsername: overrides.sshUsername } : {}),
    });
  });

/** The `paths` query parameter: a JSON array, or the 400 it was refused with. */
function parsePaths(raw: string): { readonly paths: unknown[] } | { readonly error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { error: "Invalid paths parameter" };
  }
  if (!Array.isArray(parsed)) return { error: "paths must be a JSON array of strings" };
  return { paths: parsed };
}

const SftpTransfersHandlers = HttpApiBuilder.group(SftpTransfersApi, "sftpTransfers", (handlers) =>
  handlers
    .handleRaw("upload", ({ request }) =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const form = yield* readFormFields(request);
        const accountId = formString(form, "accountId");
        const remotePath = formString(form, "remotePath");
        const file = formFile(form, "file");
        if (!accountId || !remotePath || !file) {
          return yield* badRequest("Missing accountId, remotePath, or file");
        }
        const sshConfig = yield* accountSshConfig(organizationId, accountId, {
          sshKeyId: formString(form, "sshKeyId"),
          sshHost: formString(form, "sshHost"),
          sshUsername: formString(form, "sshUsername"),
        });
        if (!sshConfig) return yield* notFound("Account not found");
        const contents = Buffer.from(yield* legacy(() => file.arrayBuffer()));
        yield* legacyTry(
          () => sftpUpload(organizationId, sshConfig, remotePath, contents),
          hostKeyTrustRefusal,
        );
        return HttpServerResponse.jsonUnsafe(ok);
      }),
    )
    .handle("download", ({ query }) =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const { accountId, paths: pathsParam } = query;
        const basePath = query.basePath ?? "";
        if (!accountId || !pathsParam) return yield* badRequest("Missing accountId or paths");
        const parsed = parsePaths(pathsParam);
        if ("error" in parsed) return yield* badRequest(parsed.error);
        // The route took the array as strings unchecked; an entry that is not
        // one (no client sends it) reaches SFTP stringified.
        const paths = parsed.paths.map((p) => (Predicate.isString(p) ? p : String(p)));
        if (paths.length === 0) return yield* badRequest("No paths specified");
        if (paths.length > MAX_BULK_PATHS) {
          return yield* badRequest(`Too many paths (max ${MAX_BULK_PATHS})`);
        }

        const sshConfig = yield* accountSshConfig(organizationId, accountId, {
          sshKeyId: query.sshKeyId,
          sshHost: query.sshHost,
          sshUsername: query.sshUsername,
        });
        if (!sshConfig) return yield* notFound("Account not found");

        const [only] = paths;
        if (paths.length === 1 && only !== undefined) {
          const data = yield* legacyTry(
            () => sftpDownloadToBuffer(organizationId, sshConfig, only),
            downloadRefusal,
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

        // Zip entry names come from remote file names, which a hostile server
        // controls. A `..` or `\\` entry would be a zip-slip for whatever extracts
        // the archive, so only plain relative paths make it in.
        const normalizedBase = basePath.endsWith("/") ? basePath : basePath ? `${basePath}/` : "";
        const relPath = (p: string): string =>
          normalizedBase && p.startsWith(normalizedBase)
            ? p.slice(normalizedBase.length)
            : path.posix.basename(p);
        const entries = paths.filter(
          (p) => !p.endsWith("/") && safeRelativePathSegments(relPath(p)),
        );

        // Pre-flight the first file so a host-key trust failure surfaces as a
        // 409 before committing to a `Content-Type: application/zip` response.
        // Once the zip stream is open, the client only sees a truncated archive.
        const [firstPath] = entries;
        if (firstPath === undefined) return yield* badRequest("No file paths in selection");
        const firstBuffer = yield* legacyTry(
          () => sftpDownloadToBuffer(organizationId, sshConfig, firstPath),
          downloadRefusal,
        );

        const passthrough = new PassThrough();
        const archive = archiver("zip", { zlib: { level: 6 } });
        archive.pipe(passthrough);
        archive.append(firstBuffer, { name: relPath(firstPath) });
        // Started inside the request's scopes and not awaited: the body is the zip.
        yield* fireAndForget(async () => {
          try {
            for (const remotePath of entries) {
              if (remotePath === firstPath) continue;
              const data = await sftpDownloadToBuffer(organizationId, sshConfig, remotePath);
              archive.append(data, { name: relPath(remotePath) });
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

export const sftpTransfersDomain = makeDomain(
  "sftp-transfers",
  SftpTransfersApi,
  SftpTransfersHandlers,
);
