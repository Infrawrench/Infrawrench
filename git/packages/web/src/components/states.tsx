/**
 * What a page shows when it has no data to show: loading, an error, nothing
 * yet. An empty state is one neutral line and the next action; it never
 * explains the feature.
 */
import type { ReactNode } from "react";
import { ApiError } from "../api/client";
import type { Pages } from "../api/queries";
import { pageColumn } from "../lib/shell";
import { Button } from "./Button";
import { Spinner } from "./icons";

/** A grey block that pulses while its content loads (still, for anyone who asks for less motion). */
export function Skeleton({
  className = "",
  width,
}: {
  className?: string;
  /** A share of the line, `"60%"`, or pixels. */
  width?: string | number;
}) {
  return (
    <span
      aria-hidden="true"
      className={`block rounded bg-surface-sunken motion-safe:animate-pulse ${className}`}
      style={width === undefined ? undefined : { width }}
    />
  );
}

/** Line widths that look like text, the same on every render. */
const WIDTHS = ["72%", "54%", "86%", "63%", "45%", "79%", "58%", "68%", "40%", "83%", "51%", "75%"];
const widthAt = (index: number): string => WIDTHS[index % WIDTHS.length]!;

/** The bar along the top of a file table or a file: a face, a name, a message, a date. */
export function CommitStripSkeleton() {
  return (
    <div className="flex h-5 items-center gap-2" aria-hidden="true">
      <Skeleton className="size-4 shrink-0 rounded-full" />
      <Skeleton className="h-3" width={96} />
      <Skeleton className="h-3 min-w-0 flex-1" width="40%" />
      <span className="flex-1" />
      <Skeleton className="h-3" width={64} />
    </div>
  );
}

export type LoadingShape = "rows" | "table" | "file" | "code" | "text" | "page" | "inline";

/** `dense`: a file table's rows, which are shorter than a list's. */
function rows(count: number, dense = false) {
  return Array.from({ length: count }, (_, index) => (
    <div
      key={index}
      className={`flex items-center gap-3 border-t border-border px-3 first:border-t-0 ${dense ? "py-1.5" : "py-2.5"}`}
    >
      <Skeleton className="size-4 shrink-0 rounded-full" />
      <Skeleton className="h-3" width={widthAt(index)} />
      <span className="flex-1" />
      <Skeleton className="h-3 shrink-0" width={56} />
    </div>
  ));
}

function codeLines(count: number) {
  return (
    <div className="code-surface space-y-2 px-3 py-3">
      {Array.from({ length: count }, (_, index) => (
        <div key={index} className="flex items-center gap-4">
          <Skeleton className="h-3 shrink-0" width={18} />
          <Skeleton className="h-3" width={widthAt(index)} />
        </div>
      ))}
    </div>
  );
}

const panel = "overflow-hidden rounded-md border border-border bg-surface-raised";
const strip = "flex min-h-9 items-center border-b border-border bg-surface-inset px-3 py-1.5";

/**
 * What a page shows while its data loads: the shape of what is coming, in
 * grey, so nothing jumps when it arrives. `shape` picks the outline: a list
 * (`rows`), a file table with its commit bar (`table`), a file (`file`), bare
 * code (`code`), prose (`text`), a whole page (`page`), or a spinner for a
 * small control (`inline`). Screen readers hear `label`.
 */
export function Loading({
  label = "Loading",
  shape = "rows",
  count,
  framed = true,
  width = "wide",
}: {
  label?: string;
  shape?: LoadingShape;
  /** Rows or lines to draw. */
  count?: number;
  /** Draw a panel around it. False where it sits inside one already. */
  framed?: boolean;
  /** For `page`: the width of the page it stands in for (`Page`'s). */
  width?: "wide" | "narrow";
}) {
  const frame = framed ? panel : "";
  const announce = <span className="sr-only">{label}</span>;
  if (shape === "inline") {
    return (
      <div
        role="status"
        className="flex items-center justify-center gap-2 px-4 py-10 text-xs text-on-surface-muted"
      >
        <Spinner />
        <span>{label}</span>
      </div>
    );
  }
  let body: ReactNode;
  switch (shape) {
    case "rows":
      body = <div className={frame}>{rows(count ?? 6)}</div>;
      break;
    case "table":
      body = (
        <div className={frame}>
          <div className={strip}>
            <span className="flex-1">
              <CommitStripSkeleton />
            </span>
          </div>
          {rows(count ?? 8, true)}
        </div>
      );
      break;
    case "file":
      body = (
        <div className="space-y-3">
          <div className={`${panel} px-3 py-2`}>
            <CommitStripSkeleton />
          </div>
          <div className={panel}>
            <div className={strip}>
              <Skeleton className="h-3" width={120} />
            </div>
            {codeLines(count ?? 16)}
          </div>
        </div>
      );
      break;
    case "code":
      body = <div className={frame}>{codeLines(count ?? 12)}</div>;
      break;
    case "text":
      body = (
        <div className={`space-y-2.5 py-2 ${framed ? "px-1" : "px-4"}`}>
          <Skeleton className="h-5" width="35%" />
          {Array.from({ length: count ?? 5 }, (_, index) => (
            <Skeleton key={index} className="h-3" width={widthAt(index + 2)} />
          ))}
        </div>
      );
      break;
    case "page":
      // Laid out as `Page` lays out the page it stands in for, so it does not
      // span the window and then shrink.
      body = (
        <div className={`${pageColumn(width)} space-y-4`}>
          <Skeleton className="h-6" width="30%" />
          <div className={panel}>{rows(count ?? 5)}</div>
        </div>
      );
      break;
  }
  return (
    <div role="status" aria-live="polite">
      {announce}
      {body}
    </div>
  );
}

export function EmptyState({
  children,
  action,
  className = "",
}: {
  /** One short line. */
  children: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={`flex flex-col items-center gap-3 px-4 py-10 text-center ${className}`}>
      <p className="text-xs text-on-surface-muted">{children}</p>
      {action}
    </div>
  );
}

export const errorMessage = (error: unknown): string =>
  error instanceof Error && error.message !== "" ? error.message : "Something went wrong";

export function ErrorState({
  error,
  onRetry,
  className = "",
}: {
  error: unknown;
  onRetry?: (() => void) | undefined;
  className?: string;
}) {
  const missing = error instanceof ApiError && error.status === 404;
  return (
    <div
      role="alert"
      className={`flex flex-col items-center gap-3 px-4 py-10 text-center ${className}`}
    >
      <p className="text-xs text-on-surface-muted">
        {missing ? (error.message === "" ? "Not found" : error.message) : errorMessage(error)}
      </p>
      {onRetry !== undefined && !missing ? (
        <Button size="sm" onClick={onRetry}>
          Try again
        </Button>
      ) : null}
    </div>
  );
}

/** An error beside the form or button that caused it. */
export function InlineError({ error }: { error: unknown }) {
  if (error === null || error === undefined) return null;
  return (
    <p role="alert" className="text-xs text-danger">
      {errorMessage(error)}
    </p>
  );
}

interface QueryLike<T> {
  readonly data: T | undefined;
  readonly error: unknown;
  readonly isPending?: boolean;
  readonly isLoading?: boolean;
  readonly refetch?: () => unknown;
}

/**
 * Renders a query: the outline of what is coming while it loads (`shape`,
 * as `Loading` takes it), the error if it failed, and `children(data)` once
 * there is data.
 */
export function QueryView<T>({
  query,
  children,
  shape,
}: {
  query: QueryLike<T>;
  children: (data: T) => ReactNode;
  shape?: LoadingShape;
}) {
  if (query.data !== undefined) return <>{children(query.data)}</>;
  if (query.error !== null && query.error !== undefined) {
    const { refetch } = query;
    return (
      <ErrorState
        error={query.error}
        onRetry={refetch === undefined ? undefined : () => void refetch()}
      />
    );
  }
  return <Loading {...(shape === undefined ? {} : { shape })} />;
}

/** The "Load more" row under a cursor-paged list (`usePages`). Renders nothing on the last page. */
export function LoadMore({
  pages,
  label = "Load more",
}: {
  pages: Pages<unknown>;
  label?: string;
}) {
  if (!pages.hasMore) return null;
  return (
    <div className="flex justify-center py-3">
      <Button size="sm" busy={pages.isLoadingMore} onClick={pages.loadMore}>
        {label}
      </Button>
    </div>
  );
}
