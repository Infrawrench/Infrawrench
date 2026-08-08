interface CostReportsIconProps {
  className?: string | undefined;
  size?: number | undefined;
}

/**
 * Cost reports glyph — a document with a bar chart on it. Same 24x24 stroke
 * grid and 2px weight as {@link CostsIcon}, so the Reports sidebar tile reads
 * as a sibling of Costs rather than a different family of icon: the page is a
 * saved, filed version of what Costs shows live.
 */
export function CostReportsIcon({ className, size = 14 }: CostReportsIconProps) {
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
      <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" />
      <path d="M14 3v6h6" />
      <path d="M8 17v-3" />
      <path d="M12 17v-5" />
      <path d="M16 17v-2" />
    </svg>
  );
}
