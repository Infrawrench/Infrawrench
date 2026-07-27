/**
 * Cloud endpoints and OAuth client. Values mirror the desktop app's
 * `env.production.ts` — the mobile app always targets the production cloud;
 * point CLOUD_URL at a dev tunnel when developing against a local server.
 */
export const CLIENT_ID = "client_01KY8MAZ7NCYMN6K44G9FFZ5KS";
export const CLOUD_URL = "https://app.infrawrench.com";
export const WORKOS_API_URL = "https://api.workos.com";

/**
 * Ask for iOS Critical Alerts when requesting notification permission, so
 * workflow pages can break through the ringer switch as well as Do Not Disturb.
 *
 * Off until Apple approves the critical-alerts entitlement and it is declared
 * in `app.config.ts` — a build without it cannot be granted the permission. Two
 * things make this a one-way door rather than a toggle, so flip it in the same
 * change as the entitlement:
 *
 * - iOS shows the authorization prompt once and grants only the options in that
 *   first request, so turning this on later reaches fresh installs only.
 * - The server decides the level per notification behind `PUSH_CRITICAL_ALERTS`
 *   (server-core `push/dispatch.ts`). Enabling one side without the other means
 *   either a permission nobody uses or a level nobody granted.
 */
export const CRITICAL_ALERTS = false;
