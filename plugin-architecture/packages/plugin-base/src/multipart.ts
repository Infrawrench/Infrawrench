/**
 * Minimal `multipart/form-data` encoder, for the uploads that cannot go
 * through a real `FormData`.
 *
 * `jsonRestFetch`'s host-HTTP path (`bodyForHostHttp`) and `services.http`
 * only carry `string | Uint8Array` bodies; a `FormData` would be stringified
 * and post the literal text "[object FormData]". Encoding the body here as a
 * `Uint8Array` (with an explicit `Content-Type` carrying the boundary) keeps
 * the upload on the host HTTP service, which is the only path that picks up
 * bastion egress routing and a custom CA.
 */

/** One part of a multipart body: either a plain text field or a file. */
export type MultipartPart =
  | { kind: "field"; name: string; value: string }
  | { kind: "file"; name: string; fileName: string; contentType: string; data: Uint8Array };

export interface MultipartBody {
  /** Value for the request's `Content-Type` header, boundary included. */
  contentType: string;
  /** The encoded body: a fresh `ArrayBuffer`-backed view `fetch` accepts as is. */
  body: Uint8Array<ArrayBuffer>;
}

/**
 * Encode `parts` into a multipart/form-data body.
 *
 * The boundary is randomised per call so it cannot collide with payload bytes
 * in practice. Field names, filenames and content types are quoted per
 * RFC 7578 section 4.2, with quotes and CR/LF stripped rather than escaped:
 * nothing legitimate a plugin sends contains them, and stripping avoids
 * emitting a header a strict parser would reject. A plugin with a stricter
 * filename policy (a fallback name, say) applies it before calling this.
 */
export function buildMultipartBody(parts: MultipartPart[]): MultipartBody {
  const boundary = `----infrawrench${randomBoundarySuffix()}`;
  const chunks: Uint8Array[] = [];
  const encoder = new TextEncoder();

  for (const part of parts) {
    const name = sanitizeHeaderValue(part.name);
    if (part.kind === "field") {
      chunks.push(
        encoder.encode(
          `--${boundary}\r\n` +
            `Content-Disposition: form-data; name="${name}"\r\n\r\n` +
            `${part.value}\r\n`,
        ),
      );
      continue;
    }

    const fileName = sanitizeHeaderValue(part.fileName);
    chunks.push(
      encoder.encode(
        `--${boundary}\r\n` +
          `Content-Disposition: form-data; name="${name}"; filename="${fileName}"\r\n` +
          `Content-Type: ${sanitizeHeaderValue(part.contentType)}\r\n\r\n`,
      ),
    );
    chunks.push(part.data);
    chunks.push(encoder.encode("\r\n"));
  }

  chunks.push(encoder.encode(`--${boundary}--\r\n`));

  const total = chunks.reduce((sum, c) => sum + c.byteLength, 0);
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }

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
