/** Small controls: copy, link tabs, segmented choice, breadcrumbs, a modal dialog. */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useLocation } from "@tanstack/react-router";
import { AppLink } from "./AppLink";
import { Button, type ButtonVariant } from "./Button";
import { Icon } from "./icons";
import { showBidi } from "../lib/bidi";

/** Copies `text`; the icon turns to a tick for a moment and the change is announced. */
export function CopyButton({
  text,
  label,
  className = "",
}: {
  text: string;
  /** What is copied: "Copy clone URL". */
  label: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => {
          setCopied(true);
          clearTimeout(timer.current);
          timer.current = setTimeout(() => setCopied(false), 1500);
        });
      }}
      className={`inline-flex size-6 shrink-0 items-center justify-center rounded text-on-surface-muted hover:bg-surface-sunken hover:text-on-surface ${className}`}
    >
      <Icon name={copied ? "check" : "copy"} size={13} className={copied ? "text-success" : ""} />
      <span role="status" className="sr-only">
        {copied ? "Copied" : ""}
      </span>
    </button>
  );
}

export interface LinkTab {
  readonly label: string;
  readonly href: string;
  readonly icon?: ReactNode;
  readonly count?: number | undefined;
  /** Whether a pathname belongs to this tab. Default: it is `href` or under it. */
  readonly match?: (pathname: string) => boolean;
}

/**
 * Tabs that are links: each is a page, and the active one comes from the
 * route. `nav` with `aria-current`, not `role=tablist`, because nothing is
 * swapped in place.
 */
export function LinkTabs({
  tabs,
  label,
  className = "",
}: {
  tabs: ReadonlyArray<LinkTab>;
  label: string;
  className?: string;
}) {
  const pathname = useLocation({ select: (location) => location.pathname });
  return (
    // Scrolls sideways on a narrow screen. Each tab's underline sits 1px over
    // the border below (`-mb-px`); the bar's own `pb-px -mb-px` keeps that
    // pixel inside it, so nothing overflows downwards and no vertical
    // scrollbar appears where the system always shows them.
    <nav
      aria-label={label}
      className={`-mb-px flex overflow-x-auto overflow-y-hidden pb-px ${className}`}
    >
      {tabs.map((tab) => {
        const path = tab.href.split("?")[0]!;
        const active = tab.match
          ? tab.match(pathname)
          : pathname === path || pathname.startsWith(`${path}/`);
        return (
          <AppLink
            key={tab.href}
            href={tab.href}
            aria-current={active ? "page" : undefined}
            className={`-mb-px flex shrink-0 items-center gap-1.5 whitespace-nowrap border-b-2 px-3 py-2 text-xs font-medium transition-colors ${
              active
                ? "border-accent text-on-surface"
                : "border-transparent text-on-surface-muted hover:border-border-strong hover:text-on-surface-secondary"
            }`}
          >
            {tab.icon}
            {tab.label}
            {tab.count !== undefined && tab.count > 0 ? (
              <span className="rounded-full bg-surface-sunken px-1.5 text-[10px] leading-4 text-on-surface-secondary">
                {tab.count}
              </span>
            ) : null}
          </AppLink>
        );
      })}
    </nav>
  );
}

/**
 * The same links as `LinkTabs`, drawn quietly: plain words, the current one
 * on a soft tile, a count as a number beside its word. For the sidebar
 * shell's bar and the branch page, where an underlined strip would be a
 * second header. `compact` shows each link as its icon alone below `xl`.
 */
export function QuietTabs({
  tabs,
  label,
  compact = false,
  className = "",
}: {
  tabs: ReadonlyArray<LinkTab>;
  label: string;
  compact?: boolean;
  className?: string;
}) {
  const pathname = useLocation({ select: (location) => location.pathname });
  return (
    <nav aria-label={label} className={`flex items-center gap-0.5 ${className}`}>
      {tabs.map((tab) => {
        const path = tab.href.split("?")[0]!;
        const active = tab.match
          ? tab.match(pathname)
          : pathname === path || pathname.startsWith(`${path}/`);
        const iconOnly = compact && tab.icon !== undefined;
        return (
          <AppLink
            key={tab.href}
            href={tab.href}
            aria-current={active ? "page" : undefined}
            title={iconOnly ? tab.label : undefined}
            className={`flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-[13px] whitespace-nowrap transition-colors ${
              active
                ? "bg-surface-sunken font-medium text-on-surface"
                : "text-on-surface-muted hover:bg-surface-sunken hover:text-on-surface"
            }`}
          >
            {iconOnly ? <span className="inline-flex xl:hidden">{tab.icon}</span> : null}
            <span className={iconOnly ? "max-xl:sr-only" : ""}>{tab.label}</span>
            {tab.count !== undefined && tab.count > 0 ? (
              <span className="text-xs font-normal text-on-surface-faint tabular-nums">
                {tab.count}
              </span>
            ) : null}
          </AppLink>
        );
      })}
    </nav>
  );
}

export interface SegmentedProps<T extends string> {
  readonly label: string;
  readonly value: T;
  readonly onChange: (value: T) => void;
  readonly options: ReadonlyArray<{ readonly value: T; readonly label: string }>;
}

/** Two or three exclusive views of the same thing (Unified | Split). */
export function Segmented<T extends string>({
  label,
  value,
  onChange,
  options,
}: SegmentedProps<T>) {
  return (
    <div role="group" aria-label={label} className="inline-flex rounded border border-border">
      {options.map((option, index) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={value === option.value}
          onClick={() => onChange(option.value)}
          className={`px-2 py-0.5 text-xs ${index > 0 ? "border-l border-border" : ""} ${
            value === option.value
              ? "bg-surface-sunken font-medium text-on-surface"
              : "text-on-surface-muted hover:text-on-surface"
          }`}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export interface Crumb {
  readonly label: string;
  /** Omitted for the current page, the last crumb. */
  readonly href?: string;
  /** The pointer rests on the link or the keyboard reaches it: a page may start loading it. */
  readonly onIntent?: () => void;
}

export function Breadcrumbs({
  crumbs,
  label = "Path",
}: {
  crumbs: ReadonlyArray<Crumb>;
  label?: string;
}) {
  return (
    <nav aria-label={label} className="min-w-0">
      <ol className="flex min-w-0 flex-wrap items-center gap-x-1 text-sm">
        {crumbs.map((crumb, index) => (
          <li key={`${index}:${crumb.label}`} className="flex min-w-0 items-center gap-x-1">
            {index > 0 ? (
              <span aria-hidden="true" className="text-on-surface-faint">
                /
              </span>
            ) : null}
            {crumb.href !== undefined ? (
              <AppLink
                href={crumb.href}
                className="truncate text-on-surface-secondary hover:underline"
                onPointerEnter={crumb.onIntent}
                onFocus={crumb.onIntent}
              >
                {showBidi(crumb.label)}
              </AppLink>
            ) : (
              <span aria-current="page" className="truncate font-semibold text-on-surface">
                {showBidi(crumb.label)}
              </span>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}

export interface DialogProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly title: string;
  readonly children: ReactNode;
  /** The buttons along the bottom, the confirming one last. */
  readonly footer?: ReactNode;
}

/** A modal on the native `<dialog>`: focus is trapped and Escape closes it. */
export function Dialog({ open, onClose, title, children, footer }: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    else if (!open && dialog.open) dialog.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onClick={(event) => {
        if (event.target === ref.current) onClose();
      }}
      className="m-auto w-full max-w-md rounded-lg border border-border bg-surface-raised p-0 text-on-surface shadow-[var(--shadow-tile-hover)] backdrop:bg-black/40"
    >
      {open ? (
        <div>
          <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
            <h2 className="text-sm font-semibold">{title}</h2>
            <button
              type="button"
              aria-label="Close"
              onClick={onClose}
              className="inline-flex size-6 items-center justify-center rounded text-on-surface-muted hover:bg-surface-sunken"
            >
              <Icon name="x" />
            </button>
          </div>
          <div className="space-y-3 px-4 py-3 text-xs">{children}</div>
          {footer !== undefined ? (
            <div className="flex justify-end gap-2 border-t border-border px-4 py-2.5">
              {footer}
            </div>
          ) : null}
        </div>
      ) : null}
    </dialog>
  );
}

/** A dialog that asks before something that cannot be undone. */
export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  children,
  confirmLabel,
  variant = "danger",
  busy = false,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  children: ReactNode;
  confirmLabel: string;
  variant?: ButtonVariant;
  busy?: boolean;
}) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant={variant} busy={busy} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      {children}
    </Dialog>
  );
}
