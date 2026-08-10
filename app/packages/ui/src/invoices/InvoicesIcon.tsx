interface InvoicesIconProps {
  className?: string | undefined;
  size?: number | undefined;
}

/**
 * Invoices glyph — a document with a torn foot and a currency mark on it. Same
 * 24x24 stroke grid and 2px weight as {@link CostsIcon} and
 * {@link CostReportsIcon}, so the three read as one family: Costs is the live
 * spend, Reports is a saved view of it, Invoices is what a customer is billed
 * for it. The serrated bottom edge is what distinguishes a bill from a report
 * at 14px, where a currency symbol alone is unreadable.
 */
export function InvoicesIcon({ className, size = 14 }: InvoicesIconProps) {
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
      <path d="M5 3h14v18l-2.3-1.8-2.4 1.8-2.3-1.8L9.7 21 7.4 19.2 5 21z" />
      <path d="M9 8h6" />
      <path d="M9 12h6" />
      <path d="M12 6v10" />
    </svg>
  );
}
