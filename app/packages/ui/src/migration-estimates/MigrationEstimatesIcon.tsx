interface MigrationEstimatesIconProps {
  className?: string | undefined;
  size?: number | undefined;
}

/**
 * Migration estimates glyph: two arrows trading places. Same 24x24 stroke grid
 * and 2px weight as the Price catalog icon it sits beside. (Lucide's
 * "arrow-right-left" icon.)
 */
export function MigrationEstimatesIcon({ className, size = 14 }: MigrationEstimatesIconProps) {
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
      <path d="m16 3 4 4-4 4" />
      <path d="M20 7H4" />
      <path d="m8 21-4-4 4-4" />
      <path d="M4 17h16" />
    </svg>
  );
}
