interface ToolsIconProps {
  className?: string | undefined;
  size?: number | undefined;
}

/**
 * Tools glyph — a hammer and a chisel crossed like the classic mason's mark.
 * The hammer is lucide's, the chisel is tabler's; both are drawn in the same
 * 24x24 stroke grid and 2px weight as the other sidebar icons, laid along
 * opposite diagonals so the pair reads as one emblem.
 */
export function ToolsIcon({ className, size = 14 }: ToolsIconProps) {
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
      {/* Hammer: head at top-right, handle to bottom-left. */}
      <path d="m15 12-9.373 9.373a1 1 0 0 1-3.001-3L12 9" />
      <path d="m18 15 4-4" />
      <path d="m21.5 11.5-1.914-1.914A2 2 0 0 1 19 8.172v-.344a2 2 0 0 0-.586-1.414l-1.657-1.657A6 6 0 0 0 12.516 3H9l1.243 1.243A6 6 0 0 1 12 8.485V10l2 2h1.172a2 2 0 0 1 1.414.586L18.5 14.5" />
      {/* Chisel: blade at top-left, grip at bottom-right. */}
      <path d="M14 14l1.5 1.5" />
      <path d="M18.347 15.575l2.08 2.079a1.96 1.96 0 0 1-2.773 2.772l-2.08-2.079a1.96 1.96 0 0 1 2.773-2.772" />
      <path d="M3 6l3-3l7.414 7.414a2 2 0 0 1 .586 1.414v2.172h-2.172a2 2 0 0 1-1.414-.586l-7.414-7.414" />
    </svg>
  );
}
