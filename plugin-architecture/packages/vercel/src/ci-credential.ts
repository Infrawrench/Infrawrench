/**
 * Lending a Vercel connection to a CI job: its access token as
 * `VERCEL_TOKEN`, which the Vercel CLI reads (`builtin:vercel`, or one a job
 * installs), so `vercel deploy` needs no `--token` on its command line. The
 * job still says which project it deploys, as anywhere else: a committed
 * `.vercel/project.json`, `VERCEL_ORG_ID` with `VERCEL_PROJECT_ID`, or
 * `--scope`.
 *
 * The token is the connection's own. Vercel can mint one that expires
 * (`POST /v3/user/tokens` with `expiresAt`), but every minted token stays in
 * the user's token list, one per job, so that is left for when a run can
 * revoke what it minted.
 */
import type { CiLentMaterial } from "@infrawrench/plugin-base";

export function lendVercelToken(accessToken: string): CiLentMaterial {
  if (!accessToken) throw new Error("This Vercel connection has no access token to lend");
  return {
    env: { VERCEL_TOKEN: accessToken },
    files: [],
    summary: "access token (VERCEL_TOKEN)",
  };
}
