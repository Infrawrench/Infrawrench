import { env } from "cloudflare:workers";
import {
  QueryError,
  queryWarehouse,
  type QueryResult,
} from "@infrawrench/server-core/aws-pricing-warehouse/query";

/**
 * The chat's read-only queries against the AWS pricing warehouse, through the
 * shared client in server-core (which the web API's
 * `POST /api/v1/aws-pricing/query` also uses).
 */
export { QueryError };

export async function query(
  sql: string,
  options: { maxRows?: number; timeoutMs?: number } = {},
): Promise<QueryResult> {
  const token = env.PRICING_WAREHOUSE_READ_TOKEN;
  if (!token) throw new QueryError("The pricing warehouse is not configured.");
  return queryWarehouse(sql, { url: env.PRICING_WAREHOUSE_URL, token }, options);
}
