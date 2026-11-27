interface GitIconProps {
  className?: string | undefined;
  size?: number | undefined;
}

/**
 * The Git entry (git.infrawrench.com): a repository folder with a branch in
 * it. lucide: folder-git-2. Not git-branch, which is the Delivery app's own
 * glyph (`products/ProductIcon.tsx`): the tool sits in that app's group, and
 * the two would read as one.
 */
export function GitIcon({ className, size = 14 }: GitIconProps) {
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
      <path d="M18 19a5 5 0 0 1-5-5v8" />
      <path d="M9 20H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H20a2 2 0 0 1 2 2v5" />
      <circle cx="13" cy="12" r="2" />
      <circle cx="20" cy="19" r="2" />
    </svg>
  );
}
