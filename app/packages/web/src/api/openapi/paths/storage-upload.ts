import { z } from "../zod";
import { strict, ErrorResponses, Uuid, Ok, OrgIdParam } from "../common";
import type { BuildContext } from "../context";

const UploadForm = strict({
  accountId: Uuid,
  bucket: z.string(),
  key: z.string(),
  file: z.string().openapi({ format: "binary", description: "Raw file bytes" }),
}).openapi("StorageUploadForm");

export function registerStorageUploadPaths(ctx: BuildContext) {
  const { registry } = ctx;

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/v1/storage/upload",
    tags: ["Storage"],
    summary: "Upload a file to object storage",
    description: "Multipart/form-data. Plugin must implement `uploadStorageObject`.",
    request: {
      params: OrgIdParam,
      body: { content: { "multipart/form-data": { schema: UploadForm } }, required: true },
    },
    responses: {
      200: { description: "Uploaded", content: { "application/json": { schema: Ok } } },
      400: ErrorResponses[400],
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/v1/storage/download",
    tags: ["Storage"],
    summary: "Download one or many objects (zipped if more than one)",
    request: {
      params: OrgIdParam,
      query: strict({
        accountId: Uuid.openapi({ param: { name: "accountId", in: "query" } }),
        bucket: z.string().openapi({ param: { name: "bucket", in: "query" } }),
        keys: z.string().openapi({
          param: { name: "keys", in: "query" },
          description: 'JSON-encoded array of object keys, e.g. `["a.txt","b.txt"]`',
        }),
      }),
    },
    responses: {
      200: {
        description: "File or zip",
        content: {
          "application/octet-stream": { schema: z.string().openapi({ format: "binary" }) },
          "application/zip": { schema: z.string().openapi({ format: "binary" }) },
        },
      },
      400: ErrorResponses[400],
      404: ErrorResponses[404],
      500: ErrorResponses[500],
    },
  });
}
