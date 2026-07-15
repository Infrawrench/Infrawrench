/**
 * Prepare a local ~/.gitconfig for an agent VM: drop `[gpg]`/`[credential]`
 * sections and `gpgsign`/`tagsign`/`signingkey` keys. Local signing keys and
 * platform credential helpers (osxkeychain, wincred) don't exist on the VM,
 * and `commit.gpgsign=true` would make every agent commit fail there.
 *
 * Pure module (no electron imports) so it stays unit-testable.
 */
export function sanitizeGitConfigForAgentVm(content: string): string {
  const lines = content.split(/\r?\n/);
  const kept: string[] = [];
  let skippingSection = false;
  for (const line of lines) {
    const section = /^\s*\[([^\]\s"]+)(?:\s+"[^"]*")?\]\s*$/.exec(line);
    if (section) {
      const name = (section[1] ?? "").toLowerCase();
      skippingSection = name === "gpg" || name === "credential";
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
    "# Signing and credential-helper settings were removed: the keys and",
    "# helpers they reference do not exist on this VM.",
    ...kept,
  ].join("\n");
}
