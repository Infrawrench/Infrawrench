interface QueryMonitorIconProps {
  className?: string | undefined;
  size?: number | undefined;
}

/**
 * Query-monitor glyph — a database drum with a magnifier over it. Same 24x24
 * stroke grid and 2px weight as BackupsIcon/MetricAlertIcon so the Query
 * monitors sidebar entry sits level with its neighbours.
 */
export function QueryMonitorIcon({ className, size = 14 }: QueryMonitorIconProps) {
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
      className={className}
    >
      <ellipse cx="10" cy="5" rx="7" ry="2.5" />
      <path d="M3 5v6c0 1.4 3.13 2.5 7 2.5" />
      <path d="M3 11v6c0 1.4 3.13 2.5 7 2.5" />
      <circle cx="16.5" cy="14.5" r="3.5" />
      <path d="M19 17l2.5 2.5" />
    </svg>
  );
}
