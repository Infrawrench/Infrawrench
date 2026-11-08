/** Response bodies the object storage and SFTP download endpoints share. */
import { Schema } from "effect";
import { HttpApiSchema } from "effect/http-api";

/** Raw file bytes in a multipart field or a binary response. */
export const BinaryFile = Schema.String.annotate({ format: "binary" });

/** A single file as `application/octet-stream`, or a zip of every requested one. */
export const FileOrZip = [
  BinaryFile.pipe(HttpApiSchema.asText({ contentType: "application/octet-stream" })),
  BinaryFile.pipe(HttpApiSchema.asText({ contentType: "application/zip" })),
] as const;
