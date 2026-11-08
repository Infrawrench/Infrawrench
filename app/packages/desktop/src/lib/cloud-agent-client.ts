import type {
  AgentClient,
  AgentCreateBody,
  AgentOpenSessionResult,
  AgentSettings,
  AgentT3PolicyApplyRequest,
} from "@infrawrench/ui/agents";
import { useUIStore } from "@infrawrench/ui";
import { cloudClient } from "./cloud-client";
import { listCloudSshInstallAccounts } from "./cloud-ssh-install";
import { runRpc } from "./rpc/client";

const agents = () => cloudClient("agents").agents;

/** A T3 Code policy setting as the server sends it: JSON cannot carry an undefined `value`. */
interface WireT3Setting {
  value?: unknown;
  locked: boolean;
}

/**
 * The policy with every setting's `value` present, as `T3CodePolicy` types
 * it. The contract makes `value` optional because a setting written without
 * one arrives without the key; the editor reads that as `undefined`, which
 * this spells out.
 */
function policyFromWire<Policy extends { settings?: Record<string, WireT3Setting> }>(
  policy: Policy,
) {
  const { settings, ...rest } = policy;
  if (settings === undefined) return rest;
  const filled: Record<string, { value: unknown; locked: boolean }> = {};
  for (const [path, setting] of Object.entries(settings)) {
    filled[path] = { value: setting.value, locked: setting.locked };
  }
  return { ...rest, settings: filled };
}

/** A settings or session row with its `t3Policy` (if any) read by {@link policyFromWire}. */
function withPolicyFromWire<
  Row extends { t3Policy?: { settings?: Record<string, WireT3Setting> } | null },
>(row: Row) {
  const { t3Policy, ...rest } = row;
  if (t3Policy === undefined) return rest;
  return { ...rest, t3Policy: t3Policy === null ? null : policyFromWire(t3Policy) };
}

/**
 * The launch command for one of the org's sessions, which the server owns
 * along with the managed org key. The resource page reads it too, to open an
 * agent tab against an org.
 */
export function openCloudAgentSession(
  orgId: string,
  sessionId: string,
): Promise<AgentOpenSessionResult> {
  return runRpc(agents().open({ params: { orgId, id: sessionId } }));
}

/**
 * Agents mode against the selected org: the desktop counterpart of
 * `web/src/lib/agent-client.ts`, over the contract's `agents` domain on the
 * cloud transport (`./cloud-client.ts`).
 *
 * The local client (`agent-client.ts`) provisions and bootstraps VMs from this
 * machine and reconciles branches into a local checkout. This one does none of
 * that: the cloud server owns the whole pipeline, so the desktop is a
 * controller for sessions the org already shares with web and mobile. That is
 * also why `pickLocalRepoPath` is absent: a folder on this laptop is not
 * something the cloud pipeline can clone, so cloud sessions take a Git URL (or
 * a repo from the org's GitHub App) exactly like web's.
 *
 * Resolves the active org at call time rather than at construction so
 * switching org under a mounted Agents tab reaches the new org's sessions:
 * same convention as the changes, costs and orphans clients.
 */
export function createCloudAgentClient(): AgentClient {
  const requireOrg = (): string => {
    const orgId = useUIStore.getState().activeCloudOrgId;
    if (!orgId) {
      throw new Error("Cloud agent sessions require an organization: sign in to sync.");
    }
    return orgId;
  };

  // Every method is `async` so a missing org rejects rather than throwing
  // synchronously: callers chain `.catch()` off these (the panel does), and a
  // sync throw would sail straight past it.
  return {
    listAccounts: async () => runRpc(agents().accounts({ params: { orgId: requireOrg() } })),
    // The same list the resource page's "Install service…" offers.
    listServiceAccounts: async () => listCloudSshInstallAccounts(requireOrg()),
    listLinkableScopes: async () =>
      (await runRpc(agents().linkScopes({ params: { orgId: requireOrg() } }))).scopes,
    getSettings: async () => {
      const settings = await runRpc(agents().settings({ params: { orgId: requireOrg() } }));
      return settings === null ? null : withPolicyFromWire(settings);
    },
    saveSettings: async (settings: AgentSettings) =>
      withPolicyFromWire(
        await runRpc(agents().saveSettings({ params: { orgId: requireOrg() }, payload: settings })),
      ),
    listSessions: async () =>
      (await runRpc(agents().sessions({ params: { orgId: requireOrg() } }))).map(
        withPolicyFromWire,
      ),
    createSession: async (body: AgentCreateBody) =>
      withPolicyFromWire(
        await runRpc(agents().createSession({ params: { orgId: requireOrg() }, payload: body })),
      ),
    openSession: async (id: string) => openCloudAgentSession(requireOrg(), id),
    reconcileSession: async (id: string) =>
      runRpc(agents().reconcile({ params: { orgId: requireOrg(), id } })),
    applyT3Policy: async (request: AgentT3PolicyApplyRequest) =>
      runRpc(agents().applyT3Policy({ params: { orgId: requireOrg() }, payload: request })),
    deleteSession: async (id: string) => {
      await runRpc(agents().deleteSession({ params: { orgId: requireOrg(), id } }));
    },
  };
}
