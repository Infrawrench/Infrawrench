interface KubernetesEfficiencyIconProps {
  className?: string | undefined;
  size?: number | undefined;
}

/**
 * Efficiency glyph: a gauge whose needle sits short of full, on the same
 * 24x24 stroke grid and 2px weight as the Costs, Reports and Canvases icons.
 * Deliberately not a vendor wheel: this is a report type, not a product.
 */
export function KubernetesEfficiencyIcon({ className, size = 14 }: KubernetesEfficiencyIconProps) {
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
      <path d="M4 17a8 8 0 1 1 16 0" />
      <path d="M12 17l4-5" />
      <path d="M4 21h16" />
    </svg>
  );
}
