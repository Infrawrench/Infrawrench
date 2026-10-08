interface SlosIconProps {
  className?: string | undefined;
  size?: number | undefined;
}

/**
 * SLO glyph: a gauge with its needle short of the top, the error budget being
 * what is left of the arc. Same 24x24 stroke grid and 2px weight as the other
 * sidebar tile icons so the SLOs entry sits level with its neighbours.
 */
export function SlosIcon({ className, size = 14 }: SlosIconProps) {
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
      <path d="M4 18a8 8 0 1 1 16 0" />
      <path d="M12 18l4-6" />
      <circle cx="12" cy="18" r="1" />
      <path d="M4 18h2" />
      <path d="M18 18h2" />
    </svg>
  );
}
