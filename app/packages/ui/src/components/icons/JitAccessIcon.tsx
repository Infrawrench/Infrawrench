interface JitAccessIconProps {
  className?: string | undefined;
  size?: number | undefined;
}

/**
 * Just-in-time access glyph: an hourglass (Lucide's, ISC). Access review sits
 * beside it as a key; this tile is about access that runs out, so it shows
 * time rather than a second key. Same 24x24 stroke grid and 2px weight as its
 * neighbours.
 */
export function JitAccessIcon({ className, size = 14 }: JitAccessIconProps) {
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
      <path d="M5 22h14" />
      <path d="M5 2h14" />
      <path d="M17 22v-4.172a2 2 0 0 0-.586-1.414L12 12l-4.414 4.414A2 2 0 0 0 7 17.828V22" />
      <path d="M7 2v4.172a2 2 0 0 0 .586 1.414L12 12l4.414-4.414A2 2 0 0 0 17 6.172V2" />
    </svg>
  );
}
