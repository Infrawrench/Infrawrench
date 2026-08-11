interface QuotasIconProps {
  className?: string | undefined;
  size?: number | undefined;
}

/**
 * Quota-radar glyph — a gauge with its needle past the middle, which is what
 * the screen is about: a bounded scale and where you sit on it. Same 24x24
 * stroke grid and 2px weight as ChangesIcon/ExpiryIcon/ProbesIcon so the
 * sidebar entry sits level with its neighbours. (Lucide's "gauge" icon.)
 */
export function QuotasIcon({ className, size = 14 }: QuotasIconProps) {
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
      <path d="m12 14 4-4" />
      <path d="M3.34 19a10 10 0 1 1 17.32 0" />
    </svg>
  );
}
