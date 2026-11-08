import {
  useUIStore,
  type IdleFindingSettings,
  type IdleFindingsOverview,
  type OrphanListResponse,
  type OrphansClient,
} from "@infrawrench/ui";
import { Effect } from "effect";
import { cloudClient } from "./cloud-client";
import { withoutNullRemediation } from "./cloud-remediation";
import { DesktopRpcClient, runRpc } from "./rpc/client";

/**
 * Potential savings data access. The same declarative orphan rules classify
 * both modes: what differs is the store they are read from, and whether cost
 * annotation is possible at all:
 *
 * - cloud: the server scans the org's synced rows and annotates each match
 *   with trailing spend from the collected billing data.
 * - local: the main process scans this machine's SQLite workspace
 *   (the `LocalOrphansList` RPC). No billing data exists locally, so the response
 *   comes back with `costBasis: "unavailable"` and the section drops the cost
 *   column rather than implying every flagged resource is free.
 *
 * The org is resolved at call time (not at client construction) so switching
 * org (including signing in or out) under a mounted Costs tab reaches the
 * right data. Same convention as the costs client.
 */
export function createDesktopOrphansClient({
  withIdleRules = false,
}: { withIdleRules?: boolean } = {}): OrphansClient {
  const client: OrphansClient = {
    listOrphans: () => {
      const orgId = useUIStore.getState().activeCloudOrgId;
      if (!orgId) return runRpc(DesktopRpcClient.use((rpc) => rpc.LocalOrphansList()));
      return runRpc(
        cloudClient("orphans")
          .orphans.list({ params: { orgId } })
          .pipe(
            Effect.map((res): OrphanListResponse => ({
              ...res,
              accounts: res.accounts.map((account) => ({
                ...account,
                resources: account.resources.map(withoutNullRemediation),
              })),
            })),
          ),
      );
    },
  };
  // Idle rules are a cloud feature (the poller reads the metrics): the
  // viewport asks for them only while signed in, and the calls still resolve
  // the org at call time and refuse in local mode.
  if (!withIdleRules) return client;
  return {
    ...client,
    idleFindings: {
      overview: (): Promise<IdleFindingsOverview> =>
        runRpc(idleFindings().overview({ params: { orgId: requireOrg() } })),
      save: (settings): Promise<IdleFindingSettings> =>
        runRpc(
          idleFindings().updateSettings({ params: { orgId: requireOrg() }, payload: settings }),
        ),
      rescan: () =>
        runRpc(
          idleFindings()
            .rescan({ params: { orgId: requireOrg() } })
            .pipe(Effect.asVoid),
        ),
    },
  };
}

const idleFindings = () => cloudClient("idleFindings").idleFindings;

function requireOrg(): string {
  const orgId = useUIStore.getState().activeCloudOrgId;
  if (!orgId) throw new Error("Idle rules need Infrawrench Cloud; sign in to tune them.");
  return orgId;
}
