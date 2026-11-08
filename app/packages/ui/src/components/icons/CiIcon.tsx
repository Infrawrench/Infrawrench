interface CiIconProps {
  className?: string | undefined;
  size?: number | undefined;
}

/**
 * CI glyph: Lucide's `list-checks`, a column of checked steps. Same 24x24
 * stroke grid and 2px weight as the other sidebar tile icons.
 */
export function CiIcon({ className, size = 14 }: CiIconProps) {
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
      <path d="m3 17 2 2 4-4" />
      <path d="m3 7 2 2 4-4" />
      <path d="M13 6h8" />
      <path d="M13 12h8" />
      <path d="M13 18h8" />
    </svg>
  );
}
