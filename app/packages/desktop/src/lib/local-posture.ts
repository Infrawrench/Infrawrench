/**
 * Local-mode posture findings. Mirrors the server's `/posture` endpoint
 * against the desktop SQLite: the main process runs client-core's
 * `computePostureFindings` over this workspace's stored accounts and
 * resources plus the `postureChecks` declarations of the loaded plugins
 * (electron/local-posture.ts, the same code `infrawrench posture --local`
 * runs). Credential-free: classification is a property of stored state, so
 * it works with the network off.
 *
 * Dismissals are local too, in the `posture_dismissals` table: accepting a
 * finding on a workspace that has never seen the cloud must not require an
 * account. Cloud mode records the same decision through the API instead
 * (lib/cloud-resources.ts), because there it is org state.
 */
import type { PostureListResponse } from "@infrawrench/ui";
import { DesktopRpcClient, runRpc } from "./rpc/client";

export function loadLocalPosture(): Promise<PostureListResponse> {
  return runRpc(DesktopRpcClient.use((rpc) => rpc.LocalPostureList()));
}

/**
 * Accept a finding in the local workspace. Idempotent on `(resource, rule)`,
 * like the cloud route: dismissing twice rewrites the note.
 */
export async function dismissLocalPostureFinding(
  resourceId: string,
  ruleId: string,
  reason: string,
): Promise<void> {
  await runRpc(
    DesktopRpcClient.use((rpc) => rpc.LocalPostureDismiss({ resourceId, ruleId, reason })),
  );
}

/** Undo a local dismissal. */
export async function restoreLocalPostureFinding(
  resourceId: string,
  ruleId: string,
): Promise<void> {
  await runRpc(DesktopRpcClient.use((rpc) => rpc.LocalPostureRestore({ resourceId, ruleId })));
}
