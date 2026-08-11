interface EnvironmentsIconProps {
  className?: string | undefined;
  size?: number | undefined;
}

/**
 * Ephemeral-environments glyph — a box with an hourglass beside it: a stack
 * you stamp out, and the clock that takes it away. Same 24x24 stroke grid and
 * 2px weight as ProbesIcon/ExpiryIcon so the sidebar entry sits level with its
 * neighbours. (Lucide's "package" body with an "hourglass" mark.)
 */
export function EnvironmentsIcon({ className, size = 14 }: EnvironmentsIconProps) {
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
      <path d="M12.9 2.6a2 2 0 0 0-1.8 0l-7 3.5A2 2 0 0 0 3 7.9v8.2a2 2 0 0 0 1.1 1.8l7 3.5a2 2 0 0 0 1.8 0" />
      <path d="M3.3 7 12 11.3 20.7 7" />
      <path d="M12 21.5V11.3" />
      <path d="M17 14h5" />
      <path d="M17 21h5" />
      <path d="M22 14c0 2.5-5 2.5-5 3.5s5 1 5 3.5" />
    </svg>
  );
}
