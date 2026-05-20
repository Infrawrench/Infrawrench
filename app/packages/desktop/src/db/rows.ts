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
