interface LogsIconProps {
  className?: string | undefined;
  size?: number | undefined;
}

/**
 * Log workspace glyph — a terminal-style pane with output lines (Lucide
 * "scroll-text" shape). Same 24x24 stroke grid and 2px weight as
 * WorkflowIcon/CostsIcon so the Logs sidebar entry sits level with its
 * neighbours.
 */
export function LogsIcon({ className, size = 14 }: LogsIconProps) {
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
      <path d="M15 12h-5" />
      <path d="M15 8h-5" />
      <path d="M19 17V5a2 2 0 0 0-2-2H4" />
      <path d="M8 21h12a2 2 0 0 0 2-2v-1a1 1 0 0 0-1-1H11a1 1 0 0 0-1 1v1a2 2 0 1 1-4 0V5a2 2 0 1 0-4 0v2a1 1 0 0 0 1 1h3" />
    </svg>
  );
}
