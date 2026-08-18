interface CalendarIconProps {
  className?: string | undefined;
  size?: number | undefined;
}

/**
 * Operations-calendar glyph — a month block with two marked days, one of them
 * a span. Same 24x24 stroke grid and 2px weight as BackupsIcon/PostureIcon so
 * the Calendar sidebar entry sits level with its neighbours.
 */
export function CalendarIcon({ className, size = 14 }: CalendarIconProps) {
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
      <rect x="3" y="5" width="18" height="16" rx="2" />
      <path d="M3 10h18" />
      <path d="M8 3v4" />
      <path d="M16 3v4" />
      <path d="M7 14h4" />
      <path d="M14 18h3" />
    </svg>
  );
}
