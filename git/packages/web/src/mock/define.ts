/**
 * What a mock handler file is made of. A file in `handlers/` default-exports
 * `defineMockHandlers({ group: { endpoint: (request) => response } })`; the
 * request and response types are the contract's, so a handler that answers
 * the wrong shape does not compile. `mock/index.ts` picks every file up.
 */
import { ApiError } from "../api/client";
import type { EndpointName, GroupName, RequestOf, ResponseOf } from "../api/types";

export type MockHandler<G extends GroupName, E extends EndpointName<G>> = (
  request: RequestOf<G, E>,
) => ResponseOf<G, E> | Promise<ResponseOf<G, E>>;

export type MockHandlers = {
  readonly [G in GroupName]?: { readonly [E in EndpointName<G>]?: MockHandler<G, E> };
};

export const defineMockHandlers = (handlers: MockHandlers): MockHandlers => handlers;

/** Throw these from a handler: the client sees the same `ApiError` a real answer gives. */
export const mockError = (status: number, error: string, code?: string) =>
  new ApiError(status, error, code);
export const notFound = (error = "Not found") => mockError(404, error);
export const badRequest = (error: string, code?: string) => mockError(400, error, code);
export const conflict = (error: string, code?: string) => mockError(409, error, code);
export const unprocessable = (error: string, code?: string) => mockError(422, error, code);
export const unauthorized = () => mockError(401, "Sign in to continue", "sign_in_required");

export type Mutable<T> = { -readonly [K in keyof T]: T[K] };

/**
 * One page of `items` for a `?cursor=&limit=` query. The cursor is the offset
 * as text, which is enough for a list that does not change under the reader.
 */
export function paginate<T>(
  items: ReadonlyArray<T>,
  query: { readonly cursor?: string | undefined; readonly limit?: number | undefined } | undefined,
): { items: T[]; nextCursor: string | null } {
  const start = Number(query?.cursor ?? 0) || 0;
  const limit = query?.limit ?? 30;
  const end = start + limit;
  return { items: items.slice(start, end), nextCursor: end < items.length ? String(end) : null };
}

export const ok = { ok: true } as const;
