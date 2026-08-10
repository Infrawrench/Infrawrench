interface FanoutIconProps {
  className?: string;
  size?: number;
}

/**
 * Fan-out SSH nav icon — one root node with elbow connectors branching to
 * three hosts: "one command, many hosts". Elbow connectors rather than the
 * diagonal share shape so it doesn't read as a twin of GraphIcon. Same 24x24
 * stroke grid and 2px weight as the rest of the sidebar family.
 */
export function FanoutIcon({ className, size = 14 }: FanoutIconProps) {
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
      <circle cx="4.5" cy="12" r="2.5" />
      <circle cx="19.5" cy="4.5" r="2" />
      <circle cx="19.5" cy="12" r="2" />
      <circle cx="19.5" cy="19.5" r="2" />
      <path d="M7 12h3.5" />
      <path d="M10.5 12V4.5h7" />
      <path d="M10.5 12h7" />
      <path d="M10.5 12v7.5h7" />
    </svg>
  );
}
