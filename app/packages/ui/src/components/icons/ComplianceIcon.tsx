interface ComplianceIconProps {
  className?: string | undefined;
  size?: number | undefined;
}

/**
 * Compliance glyph: a clipboard with a check mark. Deliberately not another
 * shield (Posture and Vulnerabilities already share that outline): compliance
 * is the checklist an auditor walks, built from what those two collect.
 */
export function ComplianceIcon({ className, size = 14 }: ComplianceIconProps) {
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
      <rect width="8" height="4" x="8" y="2" rx="1" ry="1" />
      <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
      <path d="m9 14 2 2 4-4" />
    </svg>
  );
}
