interface IacIconProps {
  className?: string | undefined;
  size?: number | undefined;
}

/**
 * Infrastructure-as-Code glyph — a document with code brackets on it, for the
 * page that reconciles declared infrastructure against what is actually
 * running. Same 24x24 stroke grid and 2px weight as ChangesIcon/CostsIcon so
 * the sidebar tile sits level with its neighbours.
 */
export function IacIcon({ className, size = 14 }: IacIconProps) {
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
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <path d="M14 2v6h6" />
      <path d="M10 12.5 8 15l2 2.5" />
      <path d="m14 12.5 2 2.5-2 2.5" />
    </svg>
  );
}
