/**
 * Build a safe `Content-Disposition: attachment` header value.
 *
 * Filenames here come from remote systems — an object key in someone's bucket,
 * a directory entry over SFTP — so they can contain quotes, backslashes,
 * newlines, and non-ASCII. Interpolating one straight into a quoted string
 * lets it break out of the quotes and append header parameters, and a raw
 * CR/LF makes Node reject the whole response.
 *
 * Emits both forms per RFC 6266: a sanitized ASCII `filename` that every
 * client understands, and a percent-encoded `filename*` (RFC 5987) carrying
 * the exact original for clients that support it.
 */

/** Strip anything that can't appear safely inside a quoted-string. */
function toAsciiFallback(filename: string): string {
  const cleaned = filename
    // Control characters, quotes, and backslashes are the escape vectors.
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f"\\]/g, "_")
    // Anything non-ASCII can't live in a quoted-string; filename* carries it.
    .replace(/[^\u0020-\u007e]/g, "_")
    .trim();
  return cleaned || "download";
}

export function attachmentDisposition(filename: string): string {
  const fallback = toAsciiFallback(filename);
  const encoded = encodeURIComponent(filename);
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}
