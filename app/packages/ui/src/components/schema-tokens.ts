/**
 * The Tailwind vocabulary for plugin-declared colours.
 *
 * `BadgeNode.color` and `StatusDotNode.status` are opaque strings chosen by a
 * plugin; every surface that renders one has to turn it into classes. Those
 * lookups used to be copied into each renderer, which is how the peer pane
 * ended up drawing a degraded resource in amber while the detail view drew the
 * same resource in yellow. One table, one answer.
 */

/** `BadgeNode.color` → pill classes. Unknown colours fall back to `gray`. */
const BADGE_CLASSES: Record<string, string> = {
  green:
    "bg-green-100 text-green-800 border border-green-300 dark:bg-green-900 dark:text-green-300 dark:border-green-700",
  yellow:
    "bg-yellow-100 text-yellow-800 border border-yellow-300 dark:bg-yellow-900 dark:text-yellow-300 dark:border-yellow-700",
  red: "bg-red-100 text-red-800 border border-red-300 dark:bg-red-900 dark:text-red-300 dark:border-red-700",
  blue: "bg-accent-muted text-accent-on-muted border border-accent-muted-border",
  gray: "bg-surface-overlay text-on-surface-tertiary border border-border-strong",
};

export function badgeClass(color: string | undefined): string {
  return (color && BADGE_CLASSES[color]) || BADGE_CLASSES["gray"]!;
}

/** `StatusDotNode.status` → dot background classes. Unknown states read as `unknown`. */
const STATUS_DOT_CLASSES: Record<string, string> = {
  healthy: "bg-emerald-400",
  degraded: "bg-yellow-400",
  error: "bg-red-400",
  unknown: "bg-surface-sunken",
  provisioning: "bg-blue-400 animate-pulse",
  info: "bg-blue-400",
};

export function statusDotClass(status: string | undefined): string {
  return (status && STATUS_DOT_CLASSES[status]) || STATUS_DOT_CLASSES["unknown"]!;
}
