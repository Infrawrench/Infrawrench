/**
 * What a page shows when it has no data to show: loading, an error, nothing
 * yet. An empty state is one neutral line and the next action; it never
 * explains the feature.
 */
import type { ReactNode } from "react";
import { ApiError } from "../api/client";
import type { Pages } from "../api/queries";
import { Button } from "./Button";
import { Spinner } from "./icons";

export function Loading({ label = "Loading" }: { label?: string }) {
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
 * Renders a query: a spinner while it loads, the error if it failed, and
 * `children(data)` once there is data.
 */
export function QueryView<T>({
  query,
  children,
}: {
  query: QueryLike<T>;
  children: (data: T) => ReactNode;
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
  return <Loading />;
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
