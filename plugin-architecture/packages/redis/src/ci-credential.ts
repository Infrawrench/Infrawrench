/**
 * Lending a Redis connection to a CI job (`manifest.ciCredential`): the URL
 * as `REDIS_URL`, which `redis-cli -u "$REDIS_URL"` and most clients take,
 * and its password as `REDISCLI_AUTH`, which `redis-cli` reads instead of
 * `-a`. An ACL user's name comes as `REDIS_USERNAME`: `redis-cli` reads no
 * user from the environment, and with a password alone it signs in as
 * `default`, so a job passes `--user "$REDIS_USERNAME"`. Verified 2026-11
 * against the redis-cli documentation (`-u` takes `redis://` and, for TLS,
 * `rediss://`) and `src/redis-cli.c` (`parseEnv` reads `REDISCLI_AUTH` only
 * when `-a` was not given; `cliAuth` sends `AUTH <user> <password>` with
 * `--user`, `AUTH <password>` without).
 */
import type {
  CiCredentialDeclaration,
  CiLentMaterial,
  CiLentValue,
} from "@infrawrench/plugin-base";

export const REDIS_CI_CREDENTIAL: CiCredentialDeclaration = {
  description:
    'The connection URL as REDIS_URL (redis-cli -u "$REDIS_URL"), its password as REDISCLI_AUTH, which redis-cli reads, and an ACL user\'s name as REDIS_USERNAME (redis-cli --user "$REDIS_USERNAME").',
  shortLived: false,
};

function decode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function lendRedis(connectionString: string): CiLentMaterial {
  if (!connectionString) throw new Error("The instance has no connection URL to lend yet.");
  const env: Record<string, CiLentValue> = { REDIS_URL: connectionString };
  try {
    const url = new URL(connectionString);
    const password = decode(url.password);
    const user = decode(url.username);
    if (password) env["REDISCLI_AUTH"] = password;
    // `default` is who a password alone signs in as.
    if (user && user !== "default") env["REDIS_USERNAME"] = [{ text: user }];
  } catch {
    // Not a URL: lent as it is.
  }
  return { env, files: [], summary: "the connection URL" };
}
