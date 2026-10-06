import { useGT } from "gt-react";
import { WarningIcon } from "./icons/ChromeIcons.js";
import { statusIssueTone } from "./schema-tokens.js";

export type IssueTone = "warning" | "danger";

/**
 * The one way the interface flags that something needs attention: a warning
 * triangle whose tooltip says why. Healthy and neutral states show nothing, so
 * the triangle only appears when there is something to read.
 */
export function IssueIndicator({
  reason,
  tone = "warning",
  size = 12,
  className = "",
}: {
  reason: string;
  tone?: IssueTone | undefined;
  size?: number | undefined;
  className?: string | undefined;
}) {
  return (
    <span
      role="img"
      title={reason}
      aria-label={reason}
      className={`inline-flex flex-shrink-0 ${tone === "danger" ? "text-danger" : "text-warning"} ${className}`}
    >
      <WarningIcon size={size} />
    </span>
  );
}

/**
 * A plugin `status-dot` status as an issue: the triangle for `error` and
 * `degraded`, nothing for anything else. `label` becomes the tooltip.
 */
export function StatusIssueIndicator({
  status,
  label,
  size,
  className,
}: {
  status: string | undefined;
  label?: string | undefined;
  size?: number | undefined;
  className?: string | undefined;
}) {
  const gt = useGT();
  const tone = statusIssueTone(status);
  if (!tone) return null;
  return (
    <IssueIndicator
      tone={tone}
      size={size}
      className={className}
      reason={label ?? (tone === "danger" ? gt("Error") : gt("Degraded"))}
    />
  );
}
