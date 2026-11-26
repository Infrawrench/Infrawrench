import type { Label } from "@infrawrench/git-contract";
import { AppLink } from "./AppLink";

/** `color` as a CSS colour when it is six hex digits (what labels store), else null. */
export const labelColor = (color: string): string | null =>
  /^[0-9a-f]{6}$/i.test(color) ? `#${color}` : null;

/** A label's own colour as a dot. Decorative: the name is beside it. */
export function LabelDot({ color, size = 8 }: { color: string; size?: number }) {
  const background = labelColor(color);
  return (
    <span
      aria-hidden="true"
      className={`inline-block shrink-0 rounded-full border border-border-strong ${
        background === null ? "bg-surface-sunken" : ""
      }`}
      style={{ width: size, height: size, backgroundColor: background ?? undefined }}
    />
  );
}

/**
 * A label on a thread. The colour is the person's, so it is drawn as a dot
 * beside the name on the theme's own surface: the name stays readable in
 * light and dark whatever colour was picked.
 */
export function LabelChip({
  label,
  href,
}: {
  label: Pick<Label, "name" | "color" | "description">;
  /** Where the label leads: the list filtered by it. */
  href?: string;
}) {
  const className =
    "inline-flex max-w-full items-center gap-1.5 rounded-full border border-border bg-surface-raised px-2 py-px text-[11px] font-medium leading-4 text-on-surface-secondary";
  const content = (
    <>
      <LabelDot color={label.color} />
      <span className="truncate">{label.name}</span>
    </>
  );
  return href === undefined ? (
    <span className={className} title={label.description ?? undefined}>
      {content}
    </span>
  ) : (
    <AppLink
      href={href}
      className={`${className} hover:border-border-strong hover:text-on-surface`}
      title={label.description ?? undefined}
    >
      {content}
    </AppLink>
  );
}
