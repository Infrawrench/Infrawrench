/**
 * Prepare a local ~/.gitconfig for an agent VM by dropping everything that
 * only works on the developer's own machine:
 *
 *  - `[gpg]` and `gpgsign`/`tagsign`/`signingkey` — the signing keys don't
 *    exist on the VM, and `commit.gpgsign=true` fails every agent commit.
 *  - `[credential]` — platform helpers (osxkeychain, wincred) aren't there.
 *  - `[url "ssh://…"]` / `[url "git@…"]` rewrites — these are the subtle one.
 *    Plenty of developers rewrite `https://github.com/` to SSH locally, which
 *    works because their machine has a key registered with the host. The VM
 *    has no such key, so the rewrite turns every HTTPS clone into an SSH one
 *    that fails `Permission denied (publickey)` — including clones of public
 *    repositories, which would otherwise need no authentication at all. Worse,
 *    the failure blames the URL the user never typed.
 *
 * Rewrites to a non-SSH target (an internal HTTPS mirror, say) are kept: they
 * may well still resolve from the VM, and they don't depend on local key
 * material.
 *
 * Pure module (no electron imports) so it stays unit-testable.
 */
export function sanitizeGitConfigForAgentVm(content: string): string {
  const lines = content.split(/\r?\n/);
  const kept: string[] = [];
  let skippingSection = false;
  for (const line of lines) {
    const section = /^\s*\[([^\]\s"]+)(?:\s+"([^"]*)")?\]\s*$/.exec(line);
    if (section) {
      const name = (section[1] ?? "").toLowerCase();
      const subject = section[2] ?? "";
      skippingSection =
        name === "gpg" || name === "credential" || (name === "url" && isSshRewriteTarget(subject));
      if (skippingSection) continue;
      kept.push(line);
      continue;
    }
    if (skippingSection) continue;
    if (/^\s*(gpgsign|tagsign|signingkey)\s*=/i.test(line)) continue;
    kept.push(line);
  }
  return [
    "# Synced from the local ~/.gitconfig by Infrawrench.",
    "# Signing, credential-helper, and SSH URL-rewrite settings were removed:",
    "# the keys, helpers, and host access they reference do not exist on this VM.",
    ...kept,
  ].join("\n");
}

/**
 * Does this `[url "<target>"]` section rewrite to an SSH endpoint?
 *
 * Covers both spellings git accepts: the explicit `ssh://git@host/` form and
 * the scp-like `git@host:` form.
 */
function isSshRewriteTarget(target: string): boolean {
  const value = target.trim();
  if (/^ssh:\/\//i.test(value)) return true;
  // scp-like: user@host: or user@host/ — deliberately not matching a bare
  // `host:port` or any URL with a scheme.
  return /^[^/@\s:]+@[^/@\s:]+[:/]/.test(value);
}
