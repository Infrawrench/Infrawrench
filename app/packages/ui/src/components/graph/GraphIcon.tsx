interface GraphIconProps {
  className?: string | undefined;
  size?: number | undefined;
}

/**
 * Dependency-graph glyph — three linked nodes. Same 24x24 stroke grid and 2px
 * weight as WorkflowIcon/CostsIcon so the sidebar tiles read as one family.
 */
export function GraphIcon({ className, size = 14 }: GraphIconProps) {
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
      <circle cx="5" cy="12" r="2.5" />
      <circle cx="19" cy="5" r="2.5" />
      <circle cx="19" cy="19" r="2.5" />
      <path d="M7.3 10.8 16.8 6" />
      <path d="M7.3 13.2 16.8 18" />
    </svg>
  );
}
