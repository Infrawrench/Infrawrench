import { Effect, Predicate } from "effect";
import { useUIStore } from "@infrawrench/ui";
import type { OffboardingClient } from "@infrawrench/ui/offboarding/OffboardingPanel";
import type {
  Offboarding,
  OffboardingActionResult,
  OffboardingItem,
  OffboardingListResponse,
  OffboardingMember,
  OffboardingStartResponse,
} from "@infrawrench/client-core";
import { cloudClient, withServerMessage } from "./cloud-client";
import { runRpc } from "./rpc/client";

// Every write fails with the server's own `{ error }` sentence
// (`withServerMessage`): an owner guard, a change freeze or a missing
// permission reads verbatim on the row.

const offboarding = () => cloudClient("offboarding").offboarding;

/** Save a generated document through the browser's own download path. */
function download(filename: string, mediaType: string, body: string): void {
  const url = URL.createObjectURL(new Blob([body], { type: mediaType }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

/**
 * Offboarding tab data access, cloud-mode only: the checklist and everything
 * it lines up live in the cloud. The org is resolved at call time, so a
 * switch under a mounted tab reaches the right organization.
 */
export function createDesktopOffboardingClient(): OffboardingClient {
  const requireOrg = (): string => {
    const orgId = useUIStore.getState().activeCloudOrgId;
    if (!orgId) throw new Error("Sign in to Infrawrench Cloud to run an offboarding");
    return orgId;
  };
  const ids = (id: string) => ({ orgId: requireOrg(), id });
  return {
    list: (): Promise<OffboardingListResponse> =>
      runRpc(
        offboarding()
          .list({ params: { orgId: requireOrg() } })
          .pipe(withServerMessage),
      ),
    get: (id): Promise<Offboarding> =>
      runRpc(
        offboarding()
          .get({ params: ids(id) })
          .pipe(withServerMessage),
      ),
    start: (input): Promise<OffboardingStartResponse> =>
      runRpc(
        offboarding()
          .start({
            params: { orgId: requireOrg() },
            payload: {
              email: input.email,
              ...(input.aliases ? { aliases: input.aliases } : {}),
              ...(input.note !== undefined ? { note: input.note } : {}),
            },
          })
          .pipe(withServerMessage),
      ),
    update: (id, patch): Promise<Offboarding> =>
      runRpc(
        offboarding()
          .update({ params: ids(id), payload: patch })
          .pipe(withServerMessage),
      ),
    rescan: (id): Promise<Offboarding> =>
      runRpc(
        offboarding()
          .rescan({ params: ids(id) })
          .pipe(withServerMessage),
      ),
    updateItem: (id, itemId, patch): Promise<OffboardingItem> =>
      runRpc(
        offboarding()
          .updateItem({ params: { ...ids(id), itemId }, payload: patch })
          .pipe(withServerMessage),
      ),
    act: (id, itemId, input): Promise<OffboardingActionResult> =>
      runRpc(
        offboarding()
          .act({
            params: { ...ids(id), itemId },
            payload: {
              action: input.action,
              ...(input.targetUserId ? { targetUserId: input.targetUserId } : {}),
            },
          })
          .pipe(withServerMessage),
      ),
    members: (): Promise<{ members: OffboardingMember[] }> =>
      runRpc(
        offboarding()
          .members({ params: { orgId: requireOrg() } })
          .pipe(withServerMessage),
      ),
    exportCsv: async (item) => {
      const body = await runRpc(
        offboarding()
          .export({ params: ids(item.id), query: { format: "csv" } })
          // A text endpoint answers the body as sent; the object branch is the
          // type's, never taken.
          .pipe(
            Effect.map((b) => (Predicate.isString(b) ? b : JSON.stringify(b, null, 2))),
            withServerMessage,
          ),
      );
      const stamp = new Date().toISOString().slice(0, 10);
      download(`offboarding-${item.email}-${stamp}.csv`, "text/csv", body);
    },
  };
}
