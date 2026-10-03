/**
 * The one test for "is this URL our own renderer bundle", used by every
 * navigation hook on the main window (will-navigate, will-redirect).
 *
 * The window holds the preload bridge, so whatever document it shows can
 * reach every IPC channel. A prefix test such as "starts with file://" also
 * admits any other local HTML file and, on Windows, `file://host/share/x.html`,
 * which is a UNC path that can be served remotely over SMB or WebDAV. So the
 * packaged app accepts exactly its own `index.html` (any hash or query; the
 * router uses hash history), and dev accepts exactly the Vite server's origin.
 */
export interface RendererLocation {
  /** `ELECTRON_RENDERER_URL` in dev, undefined when packaged. */
  devServerUrl?: string | undefined;
  /** `file://` URL of the packaged `out/renderer/index.html`. */
  indexFileUrl: string;
  /** True on Windows. */
  caseInsensitivePaths?: boolean;
}

export function isInternalRendererUrl(url: string, location: RendererLocation): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (location.devServerUrl) {
    let dev: URL;
    try {
      dev = new URL(location.devServerUrl);
    } catch {
      return false;
    }
    return parsed.origin === dev.origin;
  }
  if (parsed.protocol !== "file:") return false;
  const index = new URL(location.indexFileUrl);
  if (parsed.host !== index.host) return false;
  // Windows paths are case-insensitive and Chromium may change a drive
  // letter's case; elsewhere compare exactly.
  const fold = (p: string) => (location.caseInsensitivePaths ? p.toLowerCase() : p);
  try {
    return fold(decodeURIComponent(parsed.pathname)) === fold(decodeURIComponent(index.pathname));
  } catch {
    return false;
  }
}
