/**
 * Object storage transfers: `/api/org/:orgId/v1/storage`, the endpoint
 * definitions. Uploading one object (multipart) and downloading one or many
 * (a zip when more than one).
 *
 * Both are served raw: the upload's form is read as the Hono route read it
 * (a missing field is the route's own 400, not a schema failure), and the
 * download's query is parsed by hand (`keys` is a JSON array in a string).
 * The schemas here are what the document says clients send.
 */
import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/http-api";
import { RequiredPermission, SuccessDescription } from "../http/annotations";
import { withApiDefaults } from "../http/api-defaults";
import { BadRequest, InternalServerError, NotFound } from "../http/errors";
import { OrgAuth } from "../http/middleware-tags";
import { Ok, OrgParams, Uuid } from "../http/schemas/common";
import { documentedAs, requiredQuery } from "../http/schemas/documented";
import { FileOrZip } from "../http/schemas/file-transfer";

export const StorageUploadForm = Schema.Struct({
  accountId: Uuid,
  bucket: Schema.String,
  key: Schema.String,
  file: Schema.String.annotate({ format: "binary", description: "Raw file bytes" }),
})
  .annotate({ identifier: "StorageUploadForm" })
  .pipe(HttpApiSchema.asMultipart());

export class StorageTransfersGroup extends HttpApiGroup.make("storageTransfers")
  .add(
    HttpApiEndpoint.post("upload", "/upload", {
      params: OrgParams,
      payload: StorageUploadForm,
      success: Ok,
      error: [BadRequest, NotFound],
    })
      .annotate(RequiredPermission, "storage:write")
      .annotate(OpenApi.Summary, "Upload a file to object storage")
      .annotate(
        OpenApi.Description,
        "Multipart/form-data. Plugin must implement `uploadStorageObject`.",
      )
      .annotate(SuccessDescription, "Uploaded"),
    HttpApiEndpoint.get("download", "/download", {
      params: OrgParams,
      query: {
        accountId: Schema.optionalKey(documentedAs(Uuid)),
        bucket: Schema.optionalKey(documentedAs(Schema.String)),
        keys: Schema.optionalKey(
          documentedAs(
            Schema.String.annotate({
              description: 'JSON-encoded array of object keys, e.g. `["a.txt","b.txt"]`',
            }),
          ),
        ),
      },
      success: FileOrZip,
      error: [BadRequest, NotFound, InternalServerError],
    })
      .annotate(RequiredPermission, "storage:read")
      .annotate(OpenApi.Summary, "Download one or many objects (zipped if more than one)")
      .annotate(OpenApi.Transform, requiredQuery(["accountId", "bucket", "keys"]))
      .annotate(SuccessDescription, "File or zip"),
  )
  .prefix("/api/org/:orgId/v1/storage")
  .middleware(OrgAuth)
  .annotate(OpenApi.Title, "Storage") {}

export class StorageTransfersApi extends withApiDefaults(
  HttpApi.make("storage-transfers").add(StorageTransfersGroup),
) {}
