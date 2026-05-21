/**
 * Shared SSH key source types used by desktop components that let the user
 * pick between system-level keys (~/.ssh), app-managed keys (DB rows),
 * Pageant (Windows SSH agent), and the 1Password SSH agent.
 */

/** A system-level SSH key discovered from the user's ~/.ssh directory. */
export interface SystemKey {
  name: string;
}

/** An SSH key stored in the desktop app's local database. */
export interface AppKey {
  id: string;
  name: string;
}

/** An SSH key managed in Infrawrench Cloud — the private key lives server-side. */
export interface CloudKey {
  id: string;
  name: string;
}

/** Tagged union identifying which key a user has selected. */
export type KeySource =
  | { type: "system"; name: string }
  | { type: "app"; id: string; name: string }
  | { type: "pageant" }
  | { type: "1password" }
  | { type: "cloud"; sshKeyId: string; name: string };
