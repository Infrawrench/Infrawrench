import { z } from "../zod";
import { strict, ErrorResponses, Uuid, Ok, OrgIdParam } from "../common";
import type { BuildContext } from "../index";

const SftpUploadForm = strict({
  accountId: Uuid,
  remotePath: z.string(),
  file: z.string().openapi({ format: "binary" }),
  sshKeyId: Uuid.optional(),
  sshHost: z.string().optional(),
  sshUsername: z.string().optional(),
}).openapi("SftpUploadForm");

export function registerSftpUploadPaths(ctx: BuildContext) {
  const { registry } = ctx;

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/v1/sftp/upload",
    tags: ["SFTP"],
    summary: "Upload a file via SFTP",
    request: {
      params: OrgIdParam,
      body: { content: { "multipart/form-data": { schema: SftpUploadForm } }, required: true },
    },
    responses: {
      200: { description: "Uploaded", content: { "application/json": { schema: Ok } } },
      400: ErrorResponses[400],
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/v1/sftp/download",
    tags: ["SFTP"],
    summary: "Download one or many files via SFTP (zipped if more than one)",
    request: {
      params: OrgIdParam,
      query: strict({
        accountId: Uuid.openapi({ param: { name: "accountId", in: "query" } }),
        paths: z.string().openapi({
          param: { name: "paths", in: "query" },
          description: "JSON-encoded array of remote paths",
        }),
        basePath: z
          .string()
          .optional()
          .openapi({ param: { name: "basePath", in: "query" } }),
        sshKeyId: Uuid.optional().openapi({ param: { name: "sshKeyId", in: "query" } }),
        sshHost: z
          .string()
          .optional()
          .openapi({ param: { name: "sshHost", in: "query" } }),
        sshUsername: z
          .string()
          .optional()
          .openapi({ param: { name: "sshUsername", in: "query" } }),
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
