import type {
  AgentClient,
  AgentCreateBody,
  AgentOpenSessionResult,
  AgentSession,
  AgentSettings,
  AgentVmAccount,
} from "@infrawrench/ui/agents";
import type { SshInstallAccount } from "@infrawrench/plugin-base";
import { jsonInit, jsonOrThrow } from "./cookie-json";

export function createWebAgentClient(orgId: string): AgentClient {
  const base = `/api/org/${orgId}/agents`;
  return {
    listAccounts: () =>
      fetch(`${base}/accounts`, jsonInit("GET")).then((r) => jsonOrThrow<AgentVmAccount[]>(r)),
    // The same list the resource page's "Install service…" offers.
    listServiceAccounts: () =>
      fetch(`/api/org/${orgId}/resources/ssh-install/accounts`, jsonInit("GET")).then((r) =>
        jsonOrThrow<SshInstallAccount[]>(r),
      ),
    getSettings: () =>
      fetch(`${base}/settings`, jsonInit("GET")).then((r) => jsonOrThrow<AgentSettings | null>(r)),
    saveSettings: (settings) =>
      fetch(`${base}/settings`, jsonInit("PUT", settings)).then((r) =>
        jsonOrThrow<AgentSettings>(r),
      ),
    listSessions: () =>
      fetch(`${base}/sessions`, jsonInit("GET")).then((r) => jsonOrThrow<AgentSession[]>(r)),
    createSession: (body: AgentCreateBody) =>
      fetch(`${base}/sessions`, jsonInit("POST", body)).then((r) => jsonOrThrow<AgentSession>(r)),
    openSession: (id: string) =>
      fetch(`${base}/sessions/${id}/open`, jsonInit("POST")).then((r) =>
        jsonOrThrow<AgentOpenSessionResult>(r),
      ),
    reconcileSession: (id: string) =>
      fetch(`${base}/sessions/${id}/reconcile`, jsonInit("POST")).then((r) =>
        jsonOrThrow<{ branchName: string; message: string }>(r),
      ),
    deleteSession: async (id: string) => {
      await fetch(`${base}/sessions/${id}`, jsonInit("DELETE")).then((r) =>
        jsonOrThrow<{ ok: boolean }>(r),
      );
    },
  };
}
