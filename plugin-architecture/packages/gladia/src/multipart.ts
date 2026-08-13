/**
 * Minimal `multipart/form-data` encoder.
 *
 * `jsonRestFetch`'s host-HTTP path (`bodyForHostHttp`) stringifies a real
 * `FormData` instead of encoding it, so passing one through would silently
 * post `"[object FormData]"`. Encoding the body ourselves as a `Uint8Array`
 * keeps the upload on the host HTTP service, which is the only path that
 * picks up bastion egress routing and a custom CA.
 */

interface MultipartTextPart {
  name: string;
  value: string;
}

interface MultipartFilePart {
  name: string;
  filename: string;
  contentType: string;
  data: Uint8Array;
}

export type MultipartPart = MultipartTextPart | MultipartFilePart;

function isFilePart(part: MultipartPart): part is MultipartFilePart {
  return "data" in part;
}

/**
 * Strip anything that would break the `Content-Disposition` header. Filenames
 * arrive from a browser file picker, so they are untrusted.
 */
function sanitizeFilename(filename: string): string {
  const cleaned = filename.replace(/[\r\n"\\]/g, "_").trim();
  return cleaned.length > 0 ? cleaned : "audio";
}

export function buildMultipartBody(parts: MultipartPart[]): {
  body: Uint8Array;
  contentType: string;
} {
  const boundary = `----infrawrench${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];

  for (const part of parts) {
    if (isFilePart(part)) {
      chunks.push(
        encoder.encode(
          `--${boundary}\r\n` +
            `Content-Disposition: form-data; name="${part.name}"; filename="${sanitizeFilename(part.filename)}"\r\n` +
            `Content-Type: ${part.contentType}\r\n\r\n`,
        ),
      );
      chunks.push(part.data);
      chunks.push(encoder.encode("\r\n"));
    } else {
      chunks.push(
        encoder.encode(
          `--${boundary}\r\n` +
            `Content-Disposition: form-data; name="${part.name}"\r\n\r\n` +
            `${part.value}\r\n`,
        ),
      );
    }
  }

  chunks.push(encoder.encode(`--${boundary}--\r\n`));

  let total = 0;
  for (const chunk of chunks) total += chunk.byteLength;
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return { body, contentType: `multipart/form-data; boundary=${boundary}` };
}
