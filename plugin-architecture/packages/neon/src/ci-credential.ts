/**
 * Lending a Neon connection to a CI job: its API key as `NEON_API_KEY`,
 * which the Neon CLI reads (`builtin:neon`), so a job can create a branch
 * for a pull request, read its connection string and delete it again
 * without signing in.
 *
 * The key is the connection's own. Neon's API keys do not expire, so a
 * minted one would outlive the job until something revoked it; this lends
 * the stored key instead.
 */
import type { CiLentMaterial } from "@infrawrench/plugin-base";

export function lendNeonKey(apiKey: string): CiLentMaterial {
  if (!apiKey) throw new Error("This Neon connection has no API key to lend");
  return {
    env: { NEON_API_KEY: apiKey },
    files: [],
    summary: "API key (NEON_API_KEY)",
  };
}
