/**
 * Page numbers and sizes a list route reads raw from its query string.
 *
 * Such a route documents `page` as at least 1 and `pageSize` within a
 * maximum, but declares both as plain strings so a bad value never became a
 * 400 it did not answer before. This is where the documented bound is kept:
 * a value that is not a number reads as the default, and one out of range as
 * the nearest bound, so `?pageSize=1000000` cannot read a whole table in
 * one request.
 */
export const pageNumber = (raw: string | undefined, fallback: number, max: number): number =>
  Math.min(Math.max(parseInt(raw ?? String(fallback), 10) || fallback, 1), max);
