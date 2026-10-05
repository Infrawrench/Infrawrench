interface CostCanvasesIconProps {
  className?: string | undefined;
  size?: number | undefined;
}

/**
 * Canvases glyph: a page of tiles with a spark in the corner, on the same
 * 24x24 stroke grid and 2px weight as the Costs and Reports icons.
 */
export function CostCanvasesIcon({ className, size = 14 }: CostCanvasesIconProps) {
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
      <rect x="3" y="3" width="8" height="6" rx="1" />
      <rect x="3" y="13" width="8" height="8" rx="1" />
      <rect x="15" y="13" width="6" height="8" rx="1" />
      <path d="M18 3v6" />
      <path d="M15 6h6" />
    </svg>
  );
}
