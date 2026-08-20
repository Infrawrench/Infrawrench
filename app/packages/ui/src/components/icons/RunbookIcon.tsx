interface RunbookIconProps {
  className?: string | undefined;
  size?: number | undefined;
}

/**
 * Runbook glyph — a document with a checked list on it. Same 24x24 stroke grid
 * and 2px weight as BackupsIcon/PostureIcon so the Runbooks sidebar entry sits
 * level with its neighbours.
 */
export function RunbookIcon({ className, size = 14 }: RunbookIconProps) {
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
      <path d="M5 3h11l3 3v15a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z" />
      <path d="M15 3v4h4" />
      <path d="M8 12l1.6 1.6L13 10" />
      <path d="M8 18h8" />
    </svg>
  );
}
