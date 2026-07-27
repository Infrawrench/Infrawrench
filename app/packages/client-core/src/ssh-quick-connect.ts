/**
 * Platform-neutral pieces of the "quick connect" SSH flow — the step where a
 * resource exposes an `sshEndpoint` (EC2, droplets, Hetzner servers …) rather
 * than plugin-native credentials, so the client has to pair the host with an
 * org SSH key and a username before sending `ssh:open`.
 *
 * Lives here because web, desktop and mobile all render that step.
 */

/** Derive an SSH username from a key comment (e.g. "user@host" → "user"). Defaults to "root". */
export function deriveSSHUsername(comment: string): string {
  return comment.split("@")[0] || "root";
}

/**
 * Pick which SSH key should be selected after the key list loads.
 * A preferred agent key always wins, otherwise a previous manual selection is
 * preserved, then a key whose name matches the username, then the first key.
 */
export function pickQuickConnectKeyId(options: {
  keys: Array<{ id: string; name: string }>;
  previousId: string | null;
  effectiveUsername: string;
  preferredSshKeyId?: string | undefined;
  preferredSshKeyName?: string | undefined;
}): string | null {
  const { keys, previousId, effectiveUsername, preferredSshKeyId, preferredSshKeyName } = options;
  if (keys.length === 0) return previousId;
  const preferredKey =
    (preferredSshKeyId ? keys.find((k) => k.id === preferredSshKeyId) : undefined) ??
    (preferredSshKeyName ? keys.find((k) => k.name === preferredSshKeyName) : undefined);
  if (preferredKey) return preferredKey.id;
  if (previousId) return previousId;
  const matchByUsername = keys.find(
    (k) => k.name.toLowerCase() === effectiveUsername.toLowerCase(),
  );
  return (matchByUsername ?? keys[0]!).id;
}
