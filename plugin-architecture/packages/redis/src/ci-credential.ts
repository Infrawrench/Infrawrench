/**
 * Lending a Redis connection to a CI job (`manifest.ciCredential`): the URL
 * as `REDIS_URL`, which `redis-cli -u "$REDIS_URL"` and most clients take,
 * and its password as `REDISCLI_AUTH`, which `redis-cli` reads instead of
 * `-a`. Verified 2026-11 against the redis-cli documentation (`-u` takes
 * `redis://` and, for TLS, `rediss://`).
 */
import type {
  CiCredentialDeclaration,
  CiLentMaterial,
  CiLentValue,
} from "@infrawrench/plugin-base";

export const REDIS_CI_CREDENTIAL: CiCredentialDeclaration = {
  description:
    'The connection URL as REDIS_URL (redis-cli -u "$REDIS_URL"), and its password as REDISCLI_AUTH, which redis-cli reads.',
  shortLived: false,
};

export function lendRedis(connectionString: string): CiLentMaterial {
  if (!connectionString) throw new Error("The instance has no connection URL to lend yet.");
  const env: Record<string, CiLentValue> = { REDIS_URL: connectionString };
  try {
    const url = new URL(connectionString);
    const password = decodeURIComponent(url.password);
    if (password) env["REDISCLI_AUTH"] = password;
  } catch {
    // Not a URL: lent as it is.
  }
  return { env, files: [], summary: "the connection URL" };
}
