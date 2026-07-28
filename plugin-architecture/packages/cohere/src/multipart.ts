/**
 * Minimal `multipart/form-data` encoder.
 *
 * Cohere's transcription endpoint is the one call in this plugin that isn't
 * JSON-in. We can't hand a `FormData` to `jsonRestFetch` — the host HTTP
 * bridge's body normaliser stringifies anything that isn't a string or a
 * typed array, which would send the literal text "[object FormData]".
 *
 * So we build the body ourselves as a `Uint8Array` and pass it through
 * `jsonRestFetch` with an explicit `Content-Type` override. That keeps the
 * request on the host HTTP path, which is the only path that picks up bastion
 * egress routing and a custom CA — and the response is still JSON, so the
 * helper's parsing is exactly what we want.
 */

/** One part of a multipart body: either a plain text field or a file. */
export type MultipartPart =
  | { kind: "field"; name: string; value: string }
  | { kind: "file"; name: string; fileName: string; contentType: string; data: Uint8Array };

export interface MultipartBody {
  /** Value for the request's `Content-Type` header, boundary included. */
  contentType: string;
  /** The encoded body. */
  body: Uint8Array;
}

/**
 * Encode `parts` into a multipart/form-data body.
 *
 * The boundary is randomised per call so it cannot collide with payload bytes
 * in practice. Field names and filenames are quoted per RFC 7578 §4.2, with
 * quotes and CR/LF stripped rather than escaped — no legitimate model id,
 * language tag, or filename we send contains them, and stripping avoids
 * emitting a header a strict parser would reject.
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
