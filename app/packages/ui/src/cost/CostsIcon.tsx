interface CostsIconProps {
  className?: string | undefined;
  size?: number | undefined;
}

/**
 * Costs glyph — a rising bar chart. Same 24x24 stroke grid and 2px weight as
 * {@link WorkflowIcon}, so the Costs sidebar entry sits level with Workflows
 * rather than looking like a different family of icon.
 */
export function CostsIcon({ className, size = 14 }: CostsIconProps) {
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
      <path d="M3 3v16a2 2 0 0 0 2 2h16" />
      <rect width="4" height="5" x="7" y="11" rx="1" />
      <rect width="4" height="9" x="15" y="7" rx="1" />
    </svg>
  );
}
