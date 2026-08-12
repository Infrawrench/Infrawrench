interface BackupsIconProps {
  className?: string | undefined;
  size?: number | undefined;
}

/**
 * Backup-coverage glyph — a database drum with a clockwise restore arrow.
 * Same 24x24 stroke grid and 2px weight as PostureIcon/ExpiryIcon so the
 * Backups sidebar entry sits level with its neighbours.
 */
export function BackupsIcon({ className, size = 14 }: BackupsIconProps) {
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
      <ellipse cx="12" cy="5" rx="8" ry="3" />
      <path d="M4 5v6c0 1.66 3.58 3 8 3 .7 0 1.38-.03 2-.1" />
      <path d="M4 11v6c0 1.66 3.58 3 8 3" />
      <path d="M20 5v5" />
      <path d="M21 17a4 4 0 1 1-1.17-2.83" />
      <path d="M20 12v2.5h-2.5" />
    </svg>
  );
}
