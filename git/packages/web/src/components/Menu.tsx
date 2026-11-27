/**
 * Popovers and menus. `Popover` is the floating box under a trigger that
 * closes on Escape, on a click outside and on focus leaving it; `Menu` is a
 * popover of actions with arrow-key navigation.
 */
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { AppLink } from "./AppLink";
import { Icon } from "./icons";

export interface PopoverProps {
  /** The trigger. Spread `props` on a button; `open` is for its pressed look. */
  readonly trigger: (control: {
    props: {
      "aria-expanded": boolean;
      "aria-controls": string;
      onClick: () => void;
    };
    open: boolean;
  }) => ReactNode;
  readonly children: (control: { close: () => void }) => ReactNode;
  readonly align?: "start" | "end";
  /** Above the trigger rather than under it: for one at the foot of the page. */
  readonly side?: "bottom" | "top";
  readonly className?: string;
  readonly onOpenChange?: (open: boolean) => void;
}

export function Popover({
  trigger,
  children,
  align = "start",
  side = "bottom",
  className = "",
  onOpenChange,
}: PopoverProps) {
  const id = useId();
  const [open, setOpenState] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  const setOpen = useCallback(
    (next: boolean) => {
      setOpenState(next);
      onOpenChange?.(next);
    },
    [onOpenChange],
  );

  const close = useCallback(() => {
    setOpen(false);
    // Focus goes back to the trigger, where the keyboard user came from.
    root.current?.querySelector<HTMLElement>("[aria-expanded]")?.focus();
  }, [setOpen]);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (root.current && !root.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointer);
    return () => document.removeEventListener("pointerdown", onPointer);
  }, [open, setOpen]);

  return (
    <div
      ref={root}
      className="relative inline-block"
      onKeyDown={(event) => {
        if (event.key === "Escape" && open) {
          event.stopPropagation();
          close();
        }
      }}
      onBlur={(event) => {
        if (open && !event.currentTarget.contains(event.relatedTarget as Node | null)) {
          // Focus left for another control (Tab), not for nothing (a click on
          // the page, which the pointer listener handles).
          if (event.relatedTarget !== null) setOpen(false);
        }
      }}
    >
      {trigger({
        props: { "aria-expanded": open, "aria-controls": id, onClick: () => setOpen(!open) },
        open,
      })}
      {open ? (
        <div
          id={id}
          className={`absolute z-30 min-w-44 rounded-md border border-border bg-surface-raised shadow-[var(--shadow-tile-hover)] ${
            side === "top" ? "bottom-full mb-1" : "top-full mt-1"
          } ${align === "end" ? "right-0" : "left-0"} ${className}`}
        >
          {children({ close })}
        </div>
      ) : null}
    </div>
  );
}

/** Moves focus among the `[role=menuitem]`/`[role=option]` children of a list with the arrow keys. */
export function moveFocus(event: KeyboardEvent<HTMLElement>, selector: string): void {
  const items = Array.from(event.currentTarget.querySelectorAll<HTMLElement>(selector));
  if (items.length === 0) return;
  const index = items.indexOf(document.activeElement as HTMLElement);
  let next: number;
  switch (event.key) {
    case "ArrowDown":
      next = index < 0 ? 0 : (index + 1) % items.length;
      break;
    case "ArrowUp":
      next = index < 0 ? items.length - 1 : (index - 1 + items.length) % items.length;
      break;
    case "Home":
      next = 0;
      break;
    case "End":
      next = items.length - 1;
      break;
    default:
      return;
  }
  event.preventDefault();
  items[next]?.focus();
}

export interface MenuItem {
  readonly label: string;
  readonly icon?: ReactNode;
  /** A link item. */
  readonly href?: string;
  /** An action item. */
  readonly onSelect?: () => void;
  readonly danger?: boolean;
  readonly disabled?: boolean;
  /** Draws a rule above this item. */
  readonly separated?: boolean;
  /** One of a set of choices: drawn with a tick when true, and read as a radio item. */
  readonly checked?: boolean;
  /** A label above this item, naming the set it starts. */
  readonly heading?: string;
}

export interface MenuProps {
  readonly trigger: PopoverProps["trigger"];
  readonly items: ReadonlyArray<MenuItem>;
  readonly label: string;
  readonly align?: "start" | "end";
  readonly side?: "bottom" | "top";
  /** Shown above the items: who is signed in, what the menu is about. */
  readonly header?: ReactNode;
  readonly className?: string;
}

/**
 * Opening a menu focuses its first item, so the arrow keys work at once. The
 * focus is drawn only when the keyboard put it there (`focus-visible`), or a
 * menu opened with a click would show its first item as if hovered.
 */
const itemClass =
  "flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-surface-sunken focus:outline-none focus-visible:bg-surface-sunken disabled:opacity-50";

const ITEMS = "[role=menuitem]:not([disabled]), [role=menuitemradio]:not([disabled])";

export function Menu({ trigger, items, label, align, side, header, className }: MenuProps) {
  const list = useRef<HTMLDivElement>(null);
  return (
    <Popover
      trigger={trigger}
      align={align ?? "start"}
      side={side ?? "bottom"}
      className={className ?? ""}
      onOpenChange={(open) => {
        if (open) {
          requestAnimationFrame(() => list.current?.querySelector<HTMLElement>(ITEMS)?.focus());
        }
      }}
    >
      {({ close }) => (
        <div
          ref={list}
          role="menu"
          aria-label={label}
          className="py-1"
          onKeyDown={(event) => moveFocus(event, ITEMS)}
        >
          {header !== undefined ? (
            <div className="border-b border-border px-3 py-2 text-xs text-on-surface-muted">
              {header}
            </div>
          ) : null}
          {items.map((item) => {
            const tone = item.danger === true ? "text-danger" : "text-on-surface";
            const rule = item.separated === true ? "mt-1 border-t border-border pt-1.5" : "";
            const heading =
              item.heading !== undefined ? (
                <div
                  key={`${item.label}-heading`}
                  className={`px-3 pb-1 text-[11px] text-on-surface-muted ${rule}`}
                >
                  {item.heading}
                </div>
              ) : null;
            if (item.checked !== undefined) {
              return [
                heading,
                <button
                  key={item.label}
                  type="button"
                  role="menuitemradio"
                  aria-checked={item.checked}
                  tabIndex={-1}
                  disabled={item.disabled}
                  onClick={() => {
                    close();
                    item.onSelect?.();
                  }}
                  className={`${itemClass} ${tone} ${heading === null ? rule : ""}`}
                >
                  {item.icon}
                  <span className="flex-1">{item.label}</span>
                  {item.checked ? <Icon name="check" size={13} /> : null}
                </button>,
              ];
            }
            return item.href !== undefined ? (
              <AppLink
                key={item.label}
                role="menuitem"
                tabIndex={-1}
                href={item.href}
                onClick={close}
                className={`${itemClass} ${tone} ${rule}`}
              >
                {item.icon}
                {item.label}
              </AppLink>
            ) : (
              <button
                key={item.label}
                type="button"
                role="menuitem"
                tabIndex={-1}
                disabled={item.disabled}
                onClick={() => {
                  close();
                  item.onSelect?.();
                }}
                className={`${itemClass} ${tone} ${rule}`}
              >
                {item.icon}
                {item.label}
              </button>
            );
          })}
        </div>
      )}
    </Popover>
  );
}
