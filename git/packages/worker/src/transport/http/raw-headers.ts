/**
 * The headers a file from a repository is served with. It is somebody's
 * file on this site's origin, so nothing in it may ever run here: no type a
 * browser would execute or render as a document (HTML, SVG, XML), no
 * sniffing, a sandbox with no script, and a download rather than a page for
 * anything that is not plain text or a raster image. An `<img>` ignores
 * `Content-Disposition`, so images still show in a README.
 *
 * A separate origin for raw files (as forges use) would make this a second
 * line of defence instead of the only one; with one origin, every header
 * here matters.
 */

/** Raster images a browser draws and never runs. SVG is not one: it can carry script. */
const IMAGE_TYPES: Readonly<Record<string, string>> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  bmp: "image/bmp",
  ico: "image/x-icon",
};

/** Served with its type so an `<img>` draws it, but downloaded when opened as a page. */
const DOWNLOADED_TYPES: Readonly<Record<string, string>> = {
  svg: "image/svg+xml",
  pdf: "application/pdf",
};

/** Text, as far as a browser need know: UTF-8 with no NUL in its first 8 000 bytes. */
function isText(data: Uint8Array): boolean {
  if (data.subarray(0, 8000).includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(data);
    return true;
  } catch {
    return false;
  }
}

/**
 * `Content-Disposition` with the file's name: a plain ASCII fallback with
 * every quote, backslash and control character replaced, and the exact name
 * as RFC 5987 `filename*`, so no name can end the header or start another.
 */
export function contentDisposition(kind: "inline" | "attachment", name: string): string {
  const fallback = name.replace(/[^\x20-\x7e]|["\\%;]/g, "_") || "file";
  const exact = encodeURIComponent(name).replace(
    /['()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `${kind}; filename="${fallback}"; filename*=UTF-8''${exact}`;
}

export function rawHeaders(path: string, data: Uint8Array, download: boolean): Headers {
  const name = path.split("/").pop() ?? "";
  const extension = name.includes(".") ? (name.split(".").pop() ?? "").toLowerCase() : "";
  let type: string;
  let inline: boolean;
  if (IMAGE_TYPES[extension]) {
    type = IMAGE_TYPES[extension]!;
    inline = true;
  } else if (DOWNLOADED_TYPES[extension]) {
    type = DOWNLOADED_TYPES[extension]!;
    inline = false;
  } else if (isText(data)) {
    type = "text/plain; charset=utf-8";
    inline = true;
  } else {
    type = "application/octet-stream";
    inline = false;
  }
  return new Headers({
    "Content-Type": type,
    "Content-Disposition": contentDisposition(inline && !download ? "inline" : "attachment", name),
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; sandbox",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Cache-Control": "private, no-store",
  });
}
