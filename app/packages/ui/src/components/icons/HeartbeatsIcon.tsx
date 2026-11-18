interface HeartbeatsIconProps {
  className?: string | undefined;
  size?: number | undefined;
}

/**
 * Heartbeat-monitor glyph: a heart with a pulse line through it. Same 24x24
 * stroke grid and 2px weight as ProbesIcon so the sidebar entry sits level
 * with its neighbours. (Lucide's "heart-pulse" icon.)
 */
export function HeartbeatsIcon({ className, size = 14 }: HeartbeatsIconProps) {
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
      <path d="M2 9.5a5.5 5.5 0 0 1 9.591-3.676.56.56 0 0 0 .818 0A5.49 5.49 0 0 1 22 9.5c0 2.29-1.5 4-3 5.5l-5.492 5.313a2 2 0 0 1-3 .019L5 15c-1.5-1.5-3-3.2-3-5.5" />
      <path d="M3.22 13H9.5l.5-1 2 4.5 2-7 1.5 3.5h5.27" />
    </svg>
  );
}
