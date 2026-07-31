interface SavingsIconProps {
  className?: string | undefined;
  size?: number | undefined;
}

/**
 * Savings glyph — a circled dollar sign (Lucide's circle-dollar-sign). Same
 * 24x24 stroke grid and 2px weight as WorkflowIcon and CostsIcon so the
 * Savings sidebar tile sits level with its neighbours.
 */
export function SavingsIcon({ className, size = 14 }: SavingsIconProps) {
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
      <circle cx="12" cy="12" r="10" />
      <path d="M16 8h-6a2 2 0 1 0 0 4h4a2 2 0 1 1 0 4H8" />
      <path d="M12 18V6" />
    </svg>
  );
}
