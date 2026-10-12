/** `owner/name` from a GitHub remote URL (https or ssh), or null. */
export function githubRepoFromRemote(remote: string): string | null {
  const m = /github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(remote.trim());
  return m ? `${m[1]}/${m[2]}` : null;
}
