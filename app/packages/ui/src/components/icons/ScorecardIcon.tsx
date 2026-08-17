interface ScorecardIconProps {
  className?: string | undefined;
  size?: number | undefined;
}

/**
 * Scorecard glyph — a gauge with its needle in the upper band. Same 24x24
 * stroke grid and 2px weight as BackupsIcon/PostureIcon so the Scorecard
 * sidebar entry sits level with its neighbours.
 */
export function ScorecardIcon({ className, size = 14 }: ScorecardIconProps) {
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
      <path d="M3 17a9 9 0 0 1 18 0" />
      <path d="M12 17l4.5-4.5" />
      <path d="M3 17h2" />
      <path d="M19 17h2" />
      <circle cx="12" cy="17" r="1.4" />
    </svg>
  );
}
