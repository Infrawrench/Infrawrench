interface DomainsIconProps {
  className?: string | undefined;
  size?: number | undefined;
}

/**
 * Domains glyph — a globe with meridians. Same 24x24 stroke grid and 2px
 * weight as PostureIcon/ExpiryIcon so the Domains sidebar entry sits level
 * with its neighbours.
 */
export function DomainsIcon({ className, size = 14 }: DomainsIconProps) {
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
      <circle cx="12" cy="12" r="10" />
      <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
      <path d="M2 12h20" />
    </svg>
  );
}
