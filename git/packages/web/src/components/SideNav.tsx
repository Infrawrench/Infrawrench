import type { ReactNode } from "react";
import { useLocation } from "@tanstack/react-router";
import { pageColumn } from "../lib/shell";
import { AppLink } from "./AppLink";

export interface SideNavItem {
  readonly label: string;
  readonly href: string;
  readonly icon?: ReactNode;
  /** The item is the page at `href` exactly, not everything under it. */
  readonly exact?: boolean;
}

/** The sections of a settings area: a column of links beside the section's page. */
export function SideNav({ items, label }: { items: ReadonlyArray<SideNavItem>; label: string }) {
  const pathname = useLocation({ select: (location) => location.pathname });
  return (
    <nav aria-label={label}>
      <ul className="flex gap-0.5 overflow-x-auto md:flex-col">
        {items.map((item) => {
          const active =
            pathname === item.href || (item.exact !== true && pathname.startsWith(`${item.href}/`));
          return (
            <li key={item.href} className="shrink-0">
              <AppLink
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={`flex items-center gap-2 rounded px-2.5 py-1.5 text-xs whitespace-nowrap ${
                  active
                    ? "bg-surface-sunken font-medium text-on-surface"
                    : "text-on-surface-secondary hover:bg-surface-sunken"
                }`}
              >
                {item.icon}
                {item.label}
              </AppLink>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

/** A settings area: its sections on the left, the section's page on the right. */
export function SettingsFrame({ nav, children }: { nav: ReactNode; children: ReactNode }) {
  return (
    <div className={`${pageColumn()} grid gap-x-8 gap-y-4 md:grid-cols-[13rem_minmax(0,1fr)]`}>
      <div>{nav}</div>
      <div className="min-w-0 space-y-6">{children}</div>
    </div>
  );
}

/** One titled block of a settings page. */
export function SettingsSection({
  title,
  actions,
  children,
  danger = false,
}: {
  title: string;
  actions?: ReactNode;
  children: ReactNode;
  danger?: boolean;
}) {
  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border pb-2">
        <h2 className={`text-sm font-semibold ${danger ? "text-danger" : "text-on-surface"}`}>
          {title}
        </h2>
        {actions !== undefined ? <div className="flex items-center gap-2">{actions}</div> : null}
      </div>
      {children}
    </section>
  );
}

/** A row of a settings list: what it is on the left, its control on the right. */
export function SettingsRow({
  title,
  detail,
  children,
}: {
  title: ReactNode;
  detail?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 px-3 py-2.5">
      <div className="min-w-0">
        <div className="text-xs font-medium text-on-surface">{title}</div>
        {detail !== undefined ? (
          <div className="text-xs text-on-surface-muted">{detail}</div>
        ) : null}
      </div>
      {children !== undefined ? (
        <div className="flex shrink-0 items-center gap-2">{children}</div>
      ) : null}
    </div>
  );
}
