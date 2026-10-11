/**
 * Build-time desktop OAuth client ids. electron-vite replaces
 * `import.meta.env` with the `MAIN_VITE_*` variables present when the app was
 * built (from `.env` files or the build's process environment), so a packaged
 * app carries exactly the client ids its build was given and nothing else.
 *
 * The desktop client is public (PKCE, no secret), so the id is not a secret.
 * No GUI side effects: the CLI reads this too.
 */
import { oauthEnvPrefix } from "@infrawrench/plugin-base";

// `electron/` type-checks as CommonJS, where `import.meta` is not allowed,
// but electron-vite replaces this expression at build time and vitest runs it
// as ESM, so it is never evaluated as CommonJS.
// @ts-expect-error TS1470: see above.
const BUILD_ENV: ImportMetaEnv = (import.meta.env as ImportMetaEnv | undefined) ?? {};

/** The env var holding a plugin's desktop client id. */
export function desktopClientIdEnvKey(
  pluginId: string,
): `MAIN_VITE_PROVIDER_OAUTH_${string}_CLIENT_ID` {
  return `MAIN_VITE_${oauthEnvPrefix(pluginId)}_CLIENT_ID` as `MAIN_VITE_PROVIDER_OAUTH_${string}_CLIENT_ID`;
}

/** The desktop public client id configured at build time, or undefined. */
export function getDesktopOAuthClientId(pluginId: string): string | undefined {
  const value = BUILD_ENV[desktopClientIdEnvKey(pluginId)];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
