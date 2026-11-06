import { showcaseLabel, type ResourceShowcase, type ShowcaseTone } from "@infrawrench/plugin-base";
import { useGT } from "gt-react";
import type { ButtonHTMLAttributes, ReactNode, Ref } from "react";
import { PlusIcon } from "../components/icons/ChromeIcons.js";
import { ResourceTypeIcon } from "../components/icons/ResourceTypeIcon.js";
import { useDataString } from "../i18n/data-strings.js";

/** The footprint of a tile, shared with the skeletons and the create tile so a grid never reflows. */
export const TILE_SIZE_CLASS = "size-36";

export interface TileFrameProps {
  iconKey?: string | undefined;
  name: ReactNode;
  subtitle?: ReactNode;
  /** A further line under the subtitle, such as an active port forward. */
  detail?: ReactNode;
  /** The status line and rows from `buildResourceShowcase`. */
  showcase?: ResourceShowcase | undefined;
  /** Top right, always visible: the status indicator. */
  status?: ReactNode;
  /** Top right, revealed on hover or focus: pin and the like. */
  actions?: ReactNode;
  /** Bottom left, always visible: buttons that are the point of the tile. */
  footer?: ReactNode;
  /** Replaces `actions` while something is dragged over the tile. */
  dropHint?: ReactNode;
  isDragging?: boolean | undefined;
  /** A static tile: no button, no hover response. */
  nonInteractive?: boolean | undefined;
  /** Green-tinted border for a tile with a live session on it. */
  live?: boolean | undefined;
  buttonRef?: Ref<HTMLButtonElement> | undefined;
  /** Spread on the button filling the tile, which is also the drag handle. */
  buttonProps?: ButtonHTMLAttributes<HTMLButtonElement> | undefined;
}

/**
 * The square every resource is drawn as: name top left, the type's icon a
 * quarter out of the bottom right corner.
 *
 * The icon is centred on the corner, so `overflow-hidden` leaves exactly one
 * quadrant of it. It stays faint enough that text can run over it. The button
 * fills the frame so the whole square drags and opens, and everything else is a
 * sibling above it rather than a focusable descendant of an interactive element.
 */
export function TileFrame({
  iconKey,
  name,
  subtitle,
  detail,
  showcase,
  status,
  actions,
  footer,
  dropHint,
  isDragging,
  nonInteractive,
  live,
  buttonRef,
  buttonProps,
}: TileFrameProps) {
  const text = (
    <>
      <span
        className={`${
          showcase?.stats.length ? "line-clamp-2" : "line-clamp-3"
        } break-words text-sm font-medium leading-snug text-on-surface ${
          status || actions || dropHint ? "pr-5" : ""
        }`}
      >
        {name}
      </span>
      {subtitle && <span className="mt-1 truncate text-xs text-on-surface-muted">{subtitle}</span>}
      {detail && <span className="mt-0.5 truncate font-mono text-xs text-success">{detail}</span>}
      {showcase && <ShowcaseLines showcase={showcase} />}
    </>
  );
  const body = "absolute inset-0 flex flex-col items-stretch rounded-xl p-3 text-left";

  return (
    <div
      className={`group relative ${TILE_SIZE_CLASS} shrink-0 overflow-hidden rounded-xl border bg-surface-raised shadow-tile transition-[box-shadow,border-color,opacity] ${
        dropHint
          ? "border-accent shadow-tile-hover"
          : live
            ? "border-emerald-500/50"
            : nonInteractive
              ? "border-border"
              : "border-border hover:border-border-strong hover:shadow-tile-hover focus-within:border-border-strong"
      } ${isDragging ? "opacity-40" : ""}`}
    >
      <ResourceTypeIcon
        iconKey={iconKey}
        size={112}
        strokeWidth={1.25}
        className={`pointer-events-none absolute -bottom-14 -right-14 text-on-surface ${
          showcase?.stats.length ? "opacity-[0.07]" : "opacity-[0.13]"
        }`}
      />

      {nonInteractive ? (
        <div className={body}>{text}</div>
      ) : (
        <button
          ref={buttonRef}
          type="button"
          {...buttonProps}
          className={`${body} cursor-grab active:cursor-grabbing focus-visible:outline-offset-[-2px]`}
        >
          {text}
        </button>
      )}

      {(status || actions || dropHint) && (
        <div className="absolute right-1.5 top-1.5 flex items-center gap-0.5">
          {dropHint ?? (
            <>
              {actions && <span className="flex items-center gap-0.5">{actions}</span>}
              {status && <span className="flex size-5 items-center justify-center">{status}</span>}
            </>
          )}
        </div>
      )}

      {footer && <div className="absolute bottom-2 left-2 flex items-center gap-1">{footer}</div>}
    </div>
  );
}

const TONE_DOT: Record<ShowcaseTone, string> = {
  success: "bg-success",
  warning: "bg-warning",
  danger: "bg-danger",
  neutral: "bg-on-surface-faint",
};

/**
 * A resource's status line and its label and value rows. The rows sit at the
 * bottom of whatever holds them, over the corner icon, which is faint enough to
 * read through.
 */
export function ShowcaseLines({ showcase }: { showcase: ResourceShowcase }) {
  const gt = useGT();
  const gtData = useDataString();
  const { status, stats } = showcase;
  return (
    <>
      {status && (
        <span className="mt-1 flex min-w-0 items-center gap-1.5 text-xs text-on-surface-muted">
          <span className={`size-1.5 shrink-0 rounded-full ${TONE_DOT[status.tone]}`} />
          <span className="truncate">{gtData(status.value)}</span>
        </span>
      )}
      {stats.length > 0 && (
        <span className="mt-auto flex flex-col gap-px pt-1.5">
          {stats.map((stat) => {
            const value = stat.flag === undefined ? stat.value : stat.flag ? gt("Yes") : gt("No");
            return (
              <span
                key={stat.key}
                title={value}
                className="flex items-baseline justify-between gap-2 text-[11px] leading-4"
              >
                <span className="min-w-0 truncate text-on-surface-muted">
                  {showcaseLabel(gtData(stat.label))}
                </span>
                <span className="max-w-[70%] shrink-0 truncate font-medium tabular-nums text-on-surface-secondary">
                  {value}
                </span>
              </span>
            );
          })}
        </span>
      )}
    </>
  );
}

/** The "add another" square at the end of a row of tiles. */
export function CreateTile({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`${TILE_SIZE_CLASS} flex shrink-0 flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border-strong p-3 text-center text-sm text-on-surface-muted transition-colors hover:border-accent-subtle hover:text-on-surface`}
    >
      <PlusIcon size={18} />
      <span className="line-clamp-3 break-words leading-snug">{label}</span>
    </button>
  );
}

/** The loading stand-in for a row of tiles. */
export function TileSkeleton() {
  return <div className={`${TILE_SIZE_CLASS} animate-pulse rounded-xl bg-surface-overlay`} />;
}

export const TILE_ACTION_CLASS =
  "flex size-6 items-center justify-center rounded-md text-on-surface-muted transition-colors hover:bg-surface-overlay hover:text-on-surface disabled:opacity-50";
