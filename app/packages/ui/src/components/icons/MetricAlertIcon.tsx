interface MetricAlertIconProps {
  className?: string | undefined;
  size?: number | undefined;
}

/**
 * Metric-alerts glyph — a bell over an activity pulse. Same 24x24 stroke grid
 * and 2px weight as ChangesIcon/ExpiryIcon so the sidebar entry sits level
 * with its neighbours. (Lucide's "bell-ring"-style bell, simplified.)
 */
export function MetricAlertIcon({ className, size = 14 }: MetricAlertIconProps) {
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
      <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
      <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
    </svg>
  );
}
