import { useGT } from "gt-react";

/**
 * Marks something that is in beta: the quiet outlined label the cost alert
 * rows use, small enough to sit beside a sidebar row's name or a heading.
 */
export function BetaBadge({ className = "" }: { className?: string }) {
  const gt = useGT();
  return (
    <span
      className={`flex-shrink-0 rounded-md border border-border px-1.5 py-px text-[10px] font-medium uppercase leading-normal tracking-wide text-on-surface-faint ${className}`}
    >
      {gt("Beta")}
    </span>
  );
}
