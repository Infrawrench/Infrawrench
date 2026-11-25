/**
 * Boxes and tables. A `Panel` is the bordered box a list or a file sits in; a
 * `Table` inside one is a semantic table with the app's row density.
 */
import type {
  HTMLAttributes,
  ReactNode,
  TableHTMLAttributes,
  TdHTMLAttributes,
  ThHTMLAttributes,
} from "react";

export function Panel({ className = "", ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      {...rest}
      className={`overflow-hidden rounded-md border border-border bg-surface-raised ${className}`}
    />
  );
}

/** The strip along the top of a panel: what it shows on the left, its controls on the right. */
export function PanelHeader({
  children,
  actions,
  className = "",
}: {
  children: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`flex min-h-9 flex-wrap items-center gap-2 border-b border-border bg-surface-inset px-3 py-1.5 text-xs text-on-surface-muted ${className}`}
    >
      <div className="flex min-w-0 flex-1 items-center gap-2">{children}</div>
      {actions !== undefined ? <div className="flex items-center gap-1.5">{actions}</div> : null}
    </div>
  );
}

export interface TableProps extends TableHTMLAttributes<HTMLTableElement> {
  /** Read to screen readers; not shown. */
  readonly caption: string;
}

export function Table({ caption, className = "", children, ...rest }: TableProps) {
  return (
    <table {...rest} className={`w-full border-collapse text-xs ${className}`}>
      <caption className="sr-only">{caption}</caption>
      {children}
    </table>
  );
}

export function Th({ className = "", ...rest }: ThHTMLAttributes<HTMLTableCellElement>) {
  return (
    <th
      scope="col"
      {...rest}
      className={`border-b border-border bg-surface-inset px-3 py-1.5 text-left font-medium text-on-surface-faint ${className}`}
    />
  );
}

export function Tr({ className = "", ...rest }: HTMLAttributes<HTMLTableRowElement>) {
  return (
    <tr
      {...rest}
      className={`border-t border-border first:border-t-0 hover:bg-surface-inset ${className}`}
    />
  );
}

export function Td({ className = "", ...rest }: TdHTMLAttributes<HTMLTableCellElement>) {
  return <td {...rest} className={`px-3 py-1.5 align-middle ${className}`} />;
}

/** A page's heading row: its name on the left, its controls on the right. */
export function PageHeader({
  title,
  actions,
  children,
}: {
  title: ReactNode;
  actions?: ReactNode;
  /** A second row under the title: filters, a count. */
  children?: ReactNode;
}) {
  return (
    <div className="mb-4 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-base font-semibold text-on-surface">{title}</h1>
        {actions !== undefined ? <div className="flex items-center gap-2">{actions}</div> : null}
      </div>
      {children}
    </div>
  );
}

/** The centred column every page sits in. `narrow` is for forms. */
export function Page({
  children,
  width = "wide",
}: {
  children: ReactNode;
  width?: "wide" | "narrow";
}) {
  return (
    <div className={`mx-auto w-full px-4 py-5 ${width === "wide" ? "max-w-6xl" : "max-w-2xl"}`}>
      {children}
    </div>
  );
}
