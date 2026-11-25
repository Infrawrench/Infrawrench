import type { PendingCallToAction } from "../../shared/rpc/groups/calls-to-action";
import { DesktopRpcClient, runRpc } from "./rpc/client";

export type { PendingCallToAction };

/** The calls to action to show now, oldest first (`electron/calls-to-action.ts`). */
export function listPendingCallsToAction(input: {
  signedIn: boolean;
  locale: string;
}): Promise<ReadonlyArray<PendingCallToAction>> {
  return runRpc(DesktopRpcClient.use((rpc) => rpc.CallsToActionPending(input)));
}

/** Records that the user acted on or dismissed one, so it never shows again. */
export function completeCallToAction(id: string): Promise<void> {
  return runRpc(DesktopRpcClient.use((rpc) => rpc.CallsToActionComplete({ id })));
}
