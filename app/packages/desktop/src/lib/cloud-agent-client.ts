import type {
  AgentClient,
  AgentCreateBody,
  AgentSession,
  AgentSettings,
  AgentVmAccount,
} from "@infrawrench/ui/agents";
import { useUIStore } from "@infrawrench/ui";
import { invoke } from "./invoke";

// Full openSession response per the shared AgentClient contract — the server
// also returns the managed key (sshKeyId/sshKeyName) alongside command/cwd.
type AgentOpenSessionResult = Awaited<ReturnType<AgentClient["openSession"]>>;

/**
 * Agents mode against the selected org — the desktop counterpart of
 * `web/src/lib/agent-client.ts`, over the `cloud_agents_*` IPC.
 *
 * The local client (`agent-client.ts`) provisions and bootstraps VMs from this
 * machine and reconciles branches into a local checkout. This one does none of
 * that: the cloud server owns the whole pipeline, so the desktop is a
 * controller for sessions the org already shares with web and mobile. That is
 * also why `pickLocalRepoPath` is absent — a folder on this laptop is not
 * something the cloud pipeline can clone, so cloud sessions take a Git URL (or
 * a repo from the org's GitHub App) exactly like web's.
 *
 * Resolves the active org at call time rather than at construction so
 * switching org under a mounted Agents tab reaches the new org's sessions —
 * same convention as the changes, costs and orphans clients.
 */
export function createCloudAgentClient(): AgentClient {
  const requireOrg = (): string => {
    const orgId = useUIStore.getState().activeCloudOrgId;
    if (!orgId) {
      throw new Error("Cloud agent sessions require an organization — sign in to sync.");
    }
    return orgId;
  };

  // Every method is `async` so a missing org rejects rather than throwing
  // synchronously — callers chain `.catch()` off these (the panel does), and a
  // sync throw would sail straight past it.
  return {
    listAccounts: async () =>
      invoke<AgentVmAccount[]>("cloud_agents_accounts", { orgId: requireOrg() }),
    getSettings: async () =>
      invoke<AgentSettings | null>("cloud_agents_get_settings", { orgId: requireOrg() }),
    saveSettings: async (settings: AgentSettings) =>
      invoke<AgentSettings>("cloud_agents_save_settings", { orgId: requireOrg(), settings }),
    listSessions: async () =>
      invoke<AgentSession[]>("cloud_agents_list_sessions", { orgId: requireOrg() }),
    createSession: async (body: AgentCreateBody) =>
      invoke<AgentSession>("cloud_agents_create_session", { orgId: requireOrg(), body }),
    openSession: async (id: string) =>
      invoke<AgentOpenSessionResult>("cloud_agents_open_session", {
        orgId: requireOrg(),
        sessionId: id,
      }),
    reconcileSession: async (id: string) =>
      invoke<{ branchName: string; message: string }>("cloud_agents_reconcile_session", {
        orgId: requireOrg(),
        sessionId: id,
      }),
    deleteSession: async (id: string) => {
      await invoke<void>("cloud_agents_delete_session", {
        orgId: requireOrg(),
        sessionId: id,
      });
    },
  };
}
