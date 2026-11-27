/**
 * Parts of review a server may not serve yet (traces, findings, instructions,
 * T3 Code): it answers 503 `not_implemented`, and the page leaves that part
 * out instead of showing an error.
 */
import { ApiError } from "../../api/client";

/** The server defines the endpoint and does not serve it. */
export const isUnavailable = (error: unknown): boolean =>
  error instanceof ApiError &&
  (error.status === 503 || error.status === 501 || error.code === "not_implemented");

interface QueryLike<A> {
  readonly queryKey: readonly [string, string, unknown];
  readonly queryFn: () => Promise<A>;
}

/** A query for such a part: asked once, never retried when the answer is "not yet". */
export function optional<A>(query: QueryLike<A>) {
  return {
    ...query,
    retry: (failures: number, error: Error) =>
      failures < 2 &&
      !isUnavailable(error) &&
      !(error instanceof ApiError && error.status >= 400 && error.status < 500),
  };
}
