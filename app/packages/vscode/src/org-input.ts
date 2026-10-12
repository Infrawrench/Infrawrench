/**
 * Read an organization id out of what someone pastes: either the bare id or
 * any Infrawrench web URL inside the org (`…/org/<id>/settings/api-keys`),
 * which is the easier thing to copy. Null when neither shape is present.
 */
export function parseOrgIdInput(input: string): string | null {
  const text = input.trim();
  if (!text) return null;
  const fromUrl = /\/org\/([^/?#\s]+)/.exec(text);
  if (fromUrl) {
    try {
      return decodeURIComponent(fromUrl[1]!);
    } catch {
      return fromUrl[1]!;
    }
  }
  return /^[A-Za-z0-9_-]{4,100}$/.test(text) ? text : null;
}

/** `owner/name` from a GitHub remote URL (https or ssh), or null. */
export function githubRepoFromRemote(remote: string): string | null {
  const m = /github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(remote.trim());
  return m ? `${m[1]}/${m[2]}` : null;
}
