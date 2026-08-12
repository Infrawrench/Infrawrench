interface IncidentsIconProps {
  className?: string | undefined;
  size?: number | undefined;
}

/**
 * Incident-mode glyph — a siren/beacon: a dome on a base with a light above it.
 * Same 24x24 stroke grid and 2px weight as ProbesIcon/ChangesIcon so the
 * sidebar entry sits level with its neighbours. (Lucide's "siren".)
 *
 * Deliberately not the warning triangle: that reads as "something might be
 * wrong", which is what the posture and expiry tiles say. This one is "somebody
 * pulled the handle".
 */
export function IncidentsIcon({ className, size = 14 }: IncidentsIconProps) {
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
      <path d="M7 18v-6a5 5 0 1 1 10 0v6" />
      <path d="M5 21a1 1 0 0 0 1-1v-1a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v1a1 1 0 0 0 1 1H5Z" />
      <path d="M21 12h1" />
      <path d="M18.5 4.5 18 5" />
      <path d="M2 12h1" />
      <path d="M12 2v1" />
      <path d="m4.929 4.929.707.707" />
    </svg>
  );
}
