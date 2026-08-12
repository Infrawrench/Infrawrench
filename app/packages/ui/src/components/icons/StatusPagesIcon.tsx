interface StatusPagesIconProps {
  className?: string | undefined;
  size?: number | undefined;
}

/** Public-status-page glyph — a published document with a healthy component. */
export function StatusPagesIcon({ className, size = 14 }: StatusPagesIconProps) {
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
      <path d="M6 3h8l4 4v14H6z" />
      <path d="M14 3v5h5" />
      <path d="M9 12h6" />
      <path d="M9 16h2" />
      <circle cx="15" cy="16" r="2" />
    </svg>
  );
}
