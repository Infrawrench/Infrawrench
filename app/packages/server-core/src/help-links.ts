/**
 * The one rule for plugin-supplied help links.
 *
 * Several collection paths let a plugin attach "here is how to fix this" to a
 * failure — `CostSetupError.helpLink`, `QuotaAccessError`, `CreditAccessError`,
 * `NetworkFlowSetupError`. Every one of those strings is persisted on a poll
 * row, returned unchanged by a feed, and assigned straight to an anchor's
 * `href` in the UI. A plugin is code we ship, but it is also the least
 * reviewed code we ship and the one place a provider's own error text can
 * reach a URL, so the boundary is enforced where the value is *stored* rather
 * than trusted at every surface that later renders it.
 *
 * `https:` only, and deliberately not a permissive URL parse:
 *
 * - `javascript:` and `data:` are script execution on click.
 * - `http:` is a downgrade on a link whose whole purpose is to send an
 *   administrator to a cloud console to change a permission.
 * - A relative or scheme-less value resolves against *our* origin, which turns
 *   a "help" link into same-site navigation the user has no reason to distrust.
 *
 * Lives in its own db-free leaf so the cost path and the quota path share one
 * definition. A second copy of this check is a second chance to get it wrong,
 * and the wrong version fails open.
 */

/**
 * Return the URL if it is safe to hand a UI as an anchor target, else null.
 *
 * Null is the only failure mode: callers drop the link and keep the message,
 * because a failure explained without a link is strictly better than a link
 * that should not be clicked.
 */
export function renderableHelpUrl(url: unknown): string | null {
  if (typeof url !== "string") return null;
  // `startsWith`, not `new URL(...).protocol`: the parser accepts leading
  // whitespace and control characters that browsers then strip, so
  // `"\njavascript:alert(1)"` parses as a `javascript:` URL while a prefix
  // check on the raw string rejects it outright.
  return url.startsWith("https://") ? url : null;
}

/**
 * Both halves of a help link, or null unless both are present and the URL
 * passes {@link renderableHelpUrl}.
 *
 * A label with no URL renders as text that looks like a link and does nothing;
 * a URL with no label renders as a bare address. Neither is worth storing, so
 * the pair is all-or-nothing.
 */
export function renderableHelpLink(
  label: unknown,
  url: unknown,
): { label: string; url: string } | null {
  const safeUrl = renderableHelpUrl(url);
  if (safeUrl === null || typeof label !== "string" || label.length === 0) return null;
  return { label, url: safeUrl };
}
