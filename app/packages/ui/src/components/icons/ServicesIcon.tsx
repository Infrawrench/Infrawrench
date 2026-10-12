interface ServicesIconProps {
  className?: string | undefined;
  size?: number | undefined;
}

/**
 * Services glyph: three boxes linked to one, the resources a service groups.
 * Same 24x24 stroke grid and 2px weight as the other sidebar tile icons so the
 * Services entry sits level with its neighbours.
 */
export function ServicesIcon({ className, size = 14 }: ServicesIconProps) {
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
      <rect x="8" y="2" width="8" height="6" rx="1.5" />
      <rect x="2" y="16" width="6" height="6" rx="1.5" />
      <rect x="9" y="16" width="6" height="6" rx="1.5" />
      <rect x="16" y="16" width="6" height="6" rx="1.5" />
      <path d="M12 8v8" />
      <path d="M5 16v-3h14v3" />
    </svg>
  );
}
