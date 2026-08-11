interface AccessReviewIconProps {
  className?: string | undefined;
  size?: number | undefined;
}

/**
 * Access-review glyph — a key. Deliberately not another shield: Posture sits
 * two tiles away in the same sidebar group and the two pages answer different
 * questions ("what is exposed?" vs "who can get in?"), so they must not read
 * as variants of one another. Same 24x24 stroke grid and 2px weight as
 * PostureIcon/ExpiryIcon so the tile sits level with its neighbours.
 */
export function AccessReviewIcon({ className, size = 14 }: AccessReviewIconProps) {
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
      <path d="M2.586 17.414A2 2 0 0 0 2 18.828V21a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h.172a2 2 0 0 0 1.414-.586l.814-.814a6.5 6.5 0 1 0-4-4z" />
      <circle cx="16.5" cy="7.5" r=".5" fill="currentColor" />
    </svg>
  );
}
