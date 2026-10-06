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
    "bg-green-100 text-success-strong border border-green-300 dark:bg-green-900 dark:border-green-700",
  yellow:
    "bg-yellow-100 text-warning-strong border border-yellow-300 dark:bg-yellow-900 dark:border-yellow-700",
  red: "bg-red-100 text-danger-strong border border-red-300 dark:bg-red-900 dark:border-red-700",
  blue: "bg-accent-muted text-accent-on-muted border border-accent-muted-border",
  gray: "bg-surface-overlay text-on-surface-tertiary border border-border-strong",
};

export function badgeClass(color: string | undefined): string {
  return (color && BADGE_CLASSES[color]) || BADGE_CLASSES["gray"]!;
}

/**
 * `StatusDotNode.status` → whether it needs attention. Only problem states are
 * drawn (as a warning triangle); healthy, unknown, provisioning and info states
 * render nothing.
 */
export function statusIssueTone(status: string | undefined): "warning" | "danger" | null {
  if (status === "error") return "danger";
  if (status === "degraded") return "warning";
  return null;
}
