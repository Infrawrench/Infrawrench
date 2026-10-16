interface ResourceReportsIconProps {
  className?: string | undefined;
  size?: number | undefined;
}

/**
 * Resource reports glyph: a table with a header row and a highlighted column.
 * Same 24x24 stroke grid and 2px weight as the Cost reports icon, so the two
 * kinds of saved report read as siblings in the sidebar.
 */
export function ResourceReportsIcon({ className, size = 14 }: ResourceReportsIconProps) {
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
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M3 9h18" />
      <path d="M3 14.5h18" />
      <path d="M9 9v11" />
      <path d="M15 9v11" />
    </svg>
  );
}
