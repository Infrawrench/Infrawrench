/**
 * Minimal `multipart/form-data` encoder for the UploadThing ingest PUT.
 *
 * `FormData` cannot go through `services.http` — the host bridge only accepts
 * `string | Uint8Array`, and stringifying FormData would send the literal
 * "[object FormData]". Building the body ourselves keeps the PUT on the host
 * HTTP path so bastion egress routing still applies to ingest hosts.
 */

export interface MultipartFilePart {
  name: string;
  fileName: string;
  contentType: string;
  data: Uint8Array;
}

export interface MultipartBody {
  /** Value for the request's `Content-Type` header, boundary included. */
  contentType: string;
  body: Uint8Array;
}

/** Encode a single file part the way UploadThing's documented FormData upload does. */
export function buildMultipartFileBody(part: MultipartFilePart): MultipartBody {
  const boundary = `----infrawrench${randomBoundarySuffix()}`;
  const encoder = new TextEncoder();
  const name = sanitizeHeaderValue(part.name);
  const fileName = sanitizeHeaderValue(part.fileName);
  const contentType = sanitizeHeaderValue(part.contentType || "application/octet-stream");

  const header = encoder.encode(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="${name}"; filename="${fileName}"\r\n` +
      `Content-Type: ${contentType}\r\n\r\n`,
  );
  const trailer = encoder.encode(`\r\n--${boundary}--\r\n`);

  const body = new Uint8Array(header.byteLength + part.data.byteLength + trailer.byteLength);
  body.set(header, 0);
  body.set(part.data, header.byteLength);
  body.set(trailer, header.byteLength + part.data.byteLength);

  return { contentType: `multipart/form-data; boundary=${boundary}`, body };
}

function sanitizeHeaderValue(value: string): string {
  return value.replace(/["\r\n]/g, "");
}

function randomBoundarySuffix(): string {
  let out = "";
  for (let i = 0; i < 24; i += 1) {
    out += Math.floor(Math.random() * 36).toString(36);
  }
  return out;
}
