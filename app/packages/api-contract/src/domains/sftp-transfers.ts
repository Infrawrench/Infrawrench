/**
 * SFTP transfers: `/api/org/:orgId/v1/sftp`, the endpoint definitions.
 * Uploading one file (multipart) and downloading one or many (a zip when more
 * than one), over the account's SSH connection.
 *
 * Served raw like the object storage transfers: the form and the `paths`
 * query are read by hand, with the route's own 400s. A host whose key is not
 * trusted yet answers the shared 409 the client prompts on.
 */
import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/http-api";
import { RequiredPermission, SuccessDescription } from "../http/annotations";
import { withApiDefaults } from "../http/api-defaults";
import { BadRequest, InternalServerError, NotFound } from "../http/errors";
import { OrgAuth } from "../http/middleware-tags";
import { Ok, OrgParams, Uuid } from "../http/schemas/common";
import { documentedAs, requiredQuery } from "../http/schemas/documented";
import { SshHostKeyTrustRequired } from "../http/schemas/ssh-host-key-trust";
import { FileOrZip } from "../http/schemas/file-transfer";

export const SftpUploadForm = Schema.Struct({
  accountId: Uuid,
  remotePath: Schema.String,
  file: Schema.String.annotate({ format: "binary" }),
  sshKeyId: Schema.optionalKey(Uuid),
  sshHost: Schema.optionalKey(Schema.String),
  sshUsername: Schema.optionalKey(Schema.String),
})
  .annotate({ identifier: "SftpUploadForm" })
  .pipe(HttpApiSchema.asMultipart());

export class SftpTransfersGroup extends HttpApiGroup.make("sftpTransfers")
  .add(
    HttpApiEndpoint.post("upload", "/upload", {
      params: OrgParams,
      payload: SftpUploadForm,
      success: Ok,
      error: [BadRequest, NotFound, SshHostKeyTrustRequired],
    })
      .annotate(RequiredPermission, "storage:write")
      .annotate(OpenApi.Summary, "Upload a file via SFTP")
      .annotate(SuccessDescription, "Uploaded"),
    HttpApiEndpoint.get("download", "/download", {
      params: OrgParams,
      query: {
        accountId: Schema.optionalKey(documentedAs(Uuid)),
        paths: Schema.optionalKey(
          documentedAs(
            Schema.String.annotate({ description: "JSON-encoded array of remote paths" }),
          ),
        ),
        basePath: Schema.optionalKey(Schema.String),
        sshKeyId: Schema.optionalKey(documentedAs(Uuid)),
        sshHost: Schema.optionalKey(Schema.String),
        sshUsername: Schema.optionalKey(Schema.String),
      },
      success: FileOrZip,
      error: [BadRequest, NotFound, SshHostKeyTrustRequired, InternalServerError],
    })
      .annotate(RequiredPermission, "storage:read")
      .annotate(OpenApi.Summary, "Download one or many files via SFTP (zipped if more than one)")
      .annotate(OpenApi.Transform, requiredQuery(["accountId", "paths"]))
      .annotate(SuccessDescription, "File or zip"),
  )
  .prefix("/api/org/:orgId/v1/sftp")
  .middleware(OrgAuth)
  .annotate(OpenApi.Title, "SFTP") {}

export class SftpTransfersApi extends withApiDefaults(
  HttpApi.make("sftp-transfers").add(SftpTransfersGroup),
) {}
