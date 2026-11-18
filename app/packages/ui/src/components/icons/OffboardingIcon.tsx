interface OffboardingIconProps {
  className?: string | undefined;
  size?: number | undefined;
}

/**
 * Offboarding glyph: a person with a minus (Lucide's `user-minus`, ISC).
 * Same 24x24 stroke grid and 2px weight as the access review's key beside it.
 */
export function OffboardingIcon({ className, size = 14 }: OffboardingIconProps) {
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
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <line x1="22" x2="16" y1="11" y2="11" />
    </svg>
  );
}
