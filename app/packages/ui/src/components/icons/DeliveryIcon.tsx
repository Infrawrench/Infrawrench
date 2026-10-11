interface DeliveryIconProps {
  className?: string | undefined;
  size?: number | undefined;
}

/**
 * Delivery (DORA metrics) glyph: a rising trend line ending in an arrow over
 * a baseline. Same 24x24 stroke grid and 2px weight as the other sidebar tile
 * icons.
 */
export function DeliveryIcon({ className, size = 14 }: DeliveryIconProps) {
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
      <path d="M3 20h18" />
      <path d="M4 16l5-5 4 3 7-7" />
      <path d="M15 7h5v5" />
    </svg>
  );
}
