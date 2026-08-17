interface WallboardIconProps {
  className?: string | undefined;
  size?: number | undefined;
}

/**
 * Wallboard glyph — a screen on a stand with two tiles on it. Same 24x24 stroke
 * grid and 2px weight as BackupsIcon/PostureIcon so the Wallboard sidebar entry
 * sits level with its neighbours.
 */
export function WallboardIcon({ className, size = 14 }: WallboardIconProps) {
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
      <rect x="2" y="4" width="20" height="13" rx="2" />
      <path d="M8 21h8" />
      <path d="M12 17v4" />
      <path d="M6 9h4v4H6z" />
      <path d="M14 9h4" />
      <path d="M14 13h4" />
    </svg>
  );
}
