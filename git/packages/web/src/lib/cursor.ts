/**
 * The `cursor` of a page request: absent for the first page. A query's keys
 * are optional rather than possibly undefined, so the first page leaves the
 * key out.
 *
 *     api.issues.list({ params, query: { ...filter, ...cursorQuery(cursor), limit: 25 } })
 */
export const cursorQuery = (cursor: string | undefined): { cursor?: string } =>
  cursor === undefined ? {} : { cursor };
