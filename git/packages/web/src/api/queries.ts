/**
 * The API client for React: `useQuery(queries.contents.tree(request))`.
 *
 * `queries` mirrors `api`, each method answering the `queryKey` and `queryFn`
 * of that call. Keys are `[group, endpoint, request]`, so
 * `invalidate("repositories")` refetches a whole group and
 * `invalidate("repositories", "get")` one endpoint.
 */
import { useCallback, useMemo } from "react";
import { QueryClient, useInfiniteQuery } from "@tanstack/react-query";
import { ApiError, api } from "./client";
import type { ApiClient, EndpointName, GroupName, WireRequest } from "./types";

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: false,
      retry: (failures, error) =>
        failures < 2 && !(error instanceof ApiError && error.status >= 400 && error.status < 500),
    },
  },
});

type QueryOf<Method> = Method extends (...args: infer Args) => Promise<infer A>
  ? (...args: Args) => {
      readonly queryKey: readonly [string, string, unknown];
      readonly queryFn: () => Promise<A>;
    }
  : never;

export type ApiQueries = {
  readonly [G in GroupName]: { readonly [E in keyof ApiClient[G]]: QueryOf<ApiClient[G][E]> };
};

function makeQueries(): ApiQueries {
  const groups: Record<string, Record<string, unknown>> = {};
  const client = api as unknown as Record<
    string,
    Record<string, (request?: WireRequest) => Promise<unknown>>
  >;
  for (const [group, methods] of Object.entries(client)) {
    const built: Record<string, unknown> = {};
    for (const [endpoint, call] of Object.entries(methods)) {
      built[endpoint] = (request?: WireRequest) => ({
        queryKey: [group, endpoint, request ?? {}] as const,
        queryFn: () => call(request),
      });
    }
    groups[group] = built;
  }
  return groups as unknown as ApiQueries;
}

export const queries: ApiQueries = makeQueries();

/** Refetches every query of a group, or of one endpoint of it. */
export function invalidate<G extends GroupName>(group: G, endpoint?: EndpointName<G>) {
  return queryClient.invalidateQueries({
    queryKey: endpoint === undefined ? [group] : [group, endpoint],
  });
}

export interface PageOf<T> {
  readonly items: ReadonlyArray<T>;
  readonly nextCursor: string | null;
}

export interface Pages<T> {
  readonly items: ReadonlyArray<T>;
  /** The pages as they arrived, for a list that reads more than `items` from each. */
  readonly pages: ReadonlyArray<PageOf<T>>;
  readonly isLoading: boolean;
  readonly error: Error | null;
  readonly hasMore: boolean;
  readonly isLoadingMore: boolean;
  readonly loadMore: () => void;
}

/**
 * A cursor-paged list (`{ items, nextCursor }`), one page at a time:
 *
 *     const commits = usePages(["contents", "listCommits", request], (cursor) =>
 *       api.contents.listCommits({ ...request, query: { ...request.query, cursor } }));
 *
 * `cursor` is undefined for the first page. Render `<LoadMore pages={commits} />`
 * under the list.
 */
export function usePages<P extends PageOf<unknown>>(
  key: ReadonlyArray<unknown>,
  fetchPage: (cursor: string | undefined) => Promise<P>,
  options: { readonly enabled?: boolean } = {},
): Pages<P["items"][number]> & { readonly pages: ReadonlyArray<P> } {
  const result = useInfiniteQuery({
    queryKey: [...key, "pages"],
    queryFn: ({ pageParam }) => fetchPage(pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: options.enabled ?? true,
  });
  const pages = result.data?.pages;
  const items = useMemo(() => (pages ?? []).flatMap((page) => page.items), [pages]);
  const { fetchNextPage } = result;
  const loadMore = useCallback(() => void fetchNextPage(), [fetchNextPage]);
  return {
    items,
    pages: pages ?? [],
    isLoading: result.isLoading,
    error: result.error,
    hasMore: result.hasNextPage,
    isLoadingMore: result.isFetchingNextPage,
    loadMore,
  };
}
