/**
 * Normalizing collection failures for storage.
 *
 * Cost collection runs unattended and backs off on failure, so the reason has
 * to survive as data on the account row — otherwise a misconfigured provider
 * shows up as a permanently empty graph and the explanation only exists in a
 * poller log line nobody reads.
 */

/** What the host stores (and later renders) for a failed collection. */
export interface CostFailureDescription {
  message: string;
  helpLink: { label: string; url: string } | null;
}

/** Long enough for a provider's setup guidance, short enough to render inline. */
const MAX_ERROR_CHARS = 600;

/**
 * Normalize a thrown collection error into something storable.
 *
 * `CostSetupError` is matched structurally rather than with `instanceof`:
 * plugins are bundled with their own copy of `@infrawrench/plugin-base`, so
 * the class identity a plugin throws is never the one the host imported.
 */
export function describeCostFailure(e: unknown): CostFailureDescription {
  const raw = e instanceof Error ? e.message : String(e);
  const trimmed = raw.trim();
  const message =
    trimmed.length > MAX_ERROR_CHARS
      ? `${trimmed.slice(0, MAX_ERROR_CHARS - 1)}…`
      : trimmed || "Unknown error";

  const link = (e as { helpLink?: unknown } | null)?.helpLink;
  if (
    (e as { name?: string } | null)?.name === "CostSetupError" &&
    typeof link === "object" &&
    link !== null
  ) {
    const { label, url } = link as { label?: unknown; url?: unknown };
    // Only ever hand the UI a link it can safely render as an anchor.
    if (typeof label === "string" && typeof url === "string" && url.startsWith("https://")) {
      return { message, helpLink: { label, url } };
    }
  }
  return { message, helpLink: null };
}
