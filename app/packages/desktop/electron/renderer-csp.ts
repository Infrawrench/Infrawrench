/**
 * Content-Security-Policy for the packaged renderer, injected into the built
 * `index.html` as a `<meta>` tag by electron.vite.config.ts (a `file://` page
 * gets no response headers to carry one). Dev builds run on the Vite server,
 * whose inline React-refresh preamble and HMR need what this policy forbids,
 * so the tag is build-only.
 *
 * The renderer holds the preload bridge, so the point is `script-src`: no
 * inline script, no `eval`, and script only from the bundle itself plus the
 * one pinned Monaco build the editors load from jsDelivr (@monaco-editor/react
 * fetches it at runtime; see MONACO_CDN_BASE). Everything else is as wide as
 * the app's real traffic needs:
 *
 * - `connect-src` allows any http(s)/ws(s) origin. Plugins run in the renderer
 *   and call provider APIs directly with the user's credentials, and the set
 *   of hosts is open-ended (regional endpoints, self-hosted OpenSearch, local
 *   services through an SSH tunnel), so it cannot be enumerated.
 * - `img-src` and `media-src` allow remote http(s): avatars, bucket and
 *   Cloudinary previews, speech-provider audio.
 * - `style-src` keeps `'unsafe-inline'`: Monaco, xterm and the toast library
 *   inject `<style>` elements. Inline style cannot run script.
 */

/**
 * Must match the `paths.vs` default of the installed `@monaco-editor/loader`
 * (renderer-csp.test.ts checks it). A trailing slash makes the CSP source a
 * path prefix, so only that one package version on jsDelivr is allowed, not
 * the whole CDN.
 */
export const MONACO_CDN_BASE = "https://cdn.jsdelivr.net/npm/monaco-editor@0.55.1/";

export const RENDERER_CSP_DIRECTIVES: ReadonlyArray<readonly [string, string]> = [
  ["default-src", "'self'"],
  ["script-src", `'self' ${MONACO_CDN_BASE}`],
  ["style-src", `'self' 'unsafe-inline' ${MONACO_CDN_BASE}`],
  ["font-src", `'self' data: ${MONACO_CDN_BASE}`],
  ["img-src", "'self' data: blob: https: http:"],
  ["media-src", "'self' data: blob: https: http:"],
  ["connect-src", "'self' https: http: wss: ws: data: blob:"],
  // Monaco starts its language workers from blob: URLs that importScripts
  // the CDN build (allowed by script-src, which workers inherit).
  ["worker-src", "'self' blob:"],
  ["frame-src", "'none'"],
  ["object-src", "'none'"],
  ["base-uri", "'none'"],
  ["form-action", "'none'"],
];

export const RENDERER_CSP = RENDERER_CSP_DIRECTIVES.map(([k, v]) => `${k} ${v}`).join("; ");

/** The `<meta>` tag the build injects at the top of `<head>`. */
export function rendererCspMetaTag(): string {
  return `<meta http-equiv="Content-Security-Policy" content="${RENDERER_CSP}" />`;
}
