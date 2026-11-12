import type { CiLiveJobStatus } from "@infrawrench/client-core";

/**
 * A CI job's status as a 24x24 stroke glyph, the same grid and weight as the
 * app's other icons: a tick for passed, a cross for failed, a bang for an
 * error the runner reported, a slashed circle for skipped, a square for
 * cancelled, a turning arc for running and an empty ring for waiting. Colour comes from the status, so
 * the icon reads the same in the sidebar, the graph and the log header.
 */
export function CiStatusIcon({
  status,
  size = 14,
  className = "",
}: {
  status: CiLiveJobStatus;
  size?: number | undefined;
  className?: string | undefined;
}) {
  const tone =
    status === "passed"
      ? "text-success"
      : status === "failed" || status === "error"
        ? "text-danger"
        : status === "running"
          ? "text-warning"
          : "text-on-surface-faint";
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={`shrink-0 ${tone} ${status === "running" ? "animate-spin" : ""} ${className}`}
    >
      {status === "running" ? (
        <>
          <circle cx="12" cy="12" r="9" opacity="0.25" />
          <path d="M21 12a9 9 0 0 0-9-9" />
        </>
      ) : (
        <circle cx="12" cy="12" r="9" />
      )}
      {status === "passed" ? <path d="m8 12.5 2.5 2.5L16 9.5" /> : null}
      {status === "failed" ? <path d="m9 9 6 6m0-6-6 6" /> : null}
      {status === "error" ? (
        <>
          <path d="M12 7.5v5" />
          <path d="M12 16.5h.01" />
        </>
      ) : null}
      {status === "skipped" ? <path d="m5.6 18.4 12.8-12.8" /> : null}
      {status === "cancelled" ? <rect x="9" y="9" width="6" height="6" rx="1" /> : null}
    </svg>
  );
}
