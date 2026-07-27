/**
 * The `source` name an outside system identifies itself with when it pushes
 * costs or raises a page over the HTTP API.
 *
 * One rule for both surfaces, because a source is one idea: the caller's stable
 * name for the system doing the pushing. It ends up in a cost account id, a
 * reserved tag value, a filter pill, a paging cooldown key, and the "from" line
 * of a notification — so it is a slug (`checkout-api`), not a sentence.
 */

const SOURCE_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

/** Message for a rejected source. Phrased for the caller who sent it. */
export const SOURCE_NAME_HELP =
  'source must be 1-64 characters of letters, digits, ".", "_" or "-", starting with a letter or digit.';

/** True if `source` is a usable source name. */
export function isValidSourceName(source: unknown): source is string {
  return typeof source === "string" && SOURCE_PATTERN.test(source);
}
