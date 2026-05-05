/**
 * Shared row shapes for common queries against the desktop SQLite database.
 *
 * These mirror the `accounts` table columns in `schema.ts` — if you change
 * the schema there, update these types too.
 */

/** The full encrypted-credentials row used to load an account and decrypt its creds. */
export interface AccountRow {
  id: string;
  plugin_id: string;
  display_name: string;
  encrypted_credentials: string;
  credentials_iv: string;
}

/**
 * Narrower shape used when only the credentials need to be decrypted
 * (e.g. background metric pollers that already know the plugin_id and name).
 */
export interface AccountCredsRow {
  id: string;
  encrypted_credentials: string;
  credentials_iv: string;
}

/**
 * Variant used when the display name isn't needed but the plugin is
 * (e.g. looking up a plugin for a known resource).
 */
export interface AccountPluginCredsRow {
  id: string;
  plugin_id: string;
  encrypted_credentials: string;
  credentials_iv: string;
}
