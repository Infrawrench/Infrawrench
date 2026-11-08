/**
 * Local-mode environment diff. Mirrors the server's `/environment-diff`
 * endpoint against the desktop's local accounts: the main process runs the
 * same shared `computeEnvironmentDiff` (electron/local-environment-diff.ts,
 * shared with `infrawrench diff --local`), so a comparison reads identically
 * wherever it is run.
 *
 * Where it differs from the cloud path is the *source* of the two
 * inventories. The cloud compares rows the poller synced; local mode has no
 * such store (the desktop's `resources` table only holds what the app itself
 * created or pinned) so it enumerates both accounts through the plugin. That
 * means real provider calls, and it means a resource type whose list fails is
 * excluded rather than reported as absent: "we couldn't ask" and "prod doesn't
 * have one" are opposite answers.
 */
import type { EnvironmentDiffResponse } from "@infrawrench/ui";
import { DesktopRpcClient, runRpc } from "./rpc/client";

export function loadLocalEnvironmentDiff(
  accountIdA: string,
  accountIdB: string,
  options: { includeIdentityFields?: boolean } = {},
): Promise<EnvironmentDiffResponse> {
  return runRpc(
    DesktopRpcClient.use((rpc) =>
      rpc.LocalEnvironmentDiff({
        accountIdA,
        accountIdB,
        includeIdentityFields: options.includeIdentityFields ?? false,
      }),
    ),
  );
}
