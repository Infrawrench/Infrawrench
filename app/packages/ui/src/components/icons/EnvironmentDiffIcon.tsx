interface EnvironmentDiffIconProps {
  className?: string | undefined;
  size?: number | undefined;
}

/**
 * Environment-diff glyph — two stacked panes with a plus and a minus, the
 * side-by-side comparison the screen performs. Same 24x24 stroke grid and 2px
 * weight as ChangesIcon/ExpiryIcon so the Env diff sidebar entry sits level
 * with its neighbours.
 */
export function EnvironmentDiffIcon({ className, size = 14 }: EnvironmentDiffIconProps) {
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
      <rect x="2" y="3" width="9" height="18" rx="2" />
      <rect x="13" y="3" width="9" height="18" rx="2" />
      <path d="M4.5 12h4" />
      <path d="M15.5 12h4" />
      <path d="M17.5 10v4" />
    </svg>
  );
}
