interface WorkflowIconProps {
  className?: string | undefined;
  size?: number | undefined;
}

/**
 * Workflow glyph — two nodes joined by an elbow connector, evoking a
 * branching automation graph. Used in sidebars and tab strips so the
 * Workflows entry reads as a first-class destination alongside dashboards.
 */
export function WorkflowIcon({ className, size = 14 }: WorkflowIconProps) {
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
      <rect width="8" height="8" x="3" y="3" rx="2" />
      <path d="M7 11v4a2 2 0 0 0 2 2h4" />
      <rect width="8" height="8" x="13" y="13" rx="2" />
    </svg>
  );
}
