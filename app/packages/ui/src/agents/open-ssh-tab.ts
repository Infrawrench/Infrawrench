/**
 * Opening an agent session's SSH terminal tab.
 *
 * Shared by the agents panel (which opens the tool's terminal for Codex and
 * Claude Code sessions) and the T3 Code panel (which opens the interactive
 * `t3 connect` authorization terminal). Both go through the same
 * `POST /agents/sessions/:id/open` call — the host decides what command that
 * returns for the session's tool.
 */
import { resourceSshTabTarget } from "../workspace-tabs.js";
import { useUIStore } from "../store/ui.store.js";
import type { AgentClient, AgentSession } from "./types.js";

export type AgentSshTabTarget = ReturnType<typeof resourceSshTabTarget>;

export interface OpenAgentSshTerminalTabInput {
  client: AgentClient;
  session: Pick<AgentSession, "id" | "accountId" | "pluginId" | "resourceTypeId" | "vmResourceId">;
  /** Tab title, e.g. "claude · my-project" or "T3 Code setup · my-server". */
  title: string;
  /** Platform route navigation; the tab is created either way. */
  openWorkspaceTarget?: (target: AgentSshTabTarget, title: string) => void;
}

/**
 * Resolve the session's launch command and open it in a fresh SSH tab.
 * Any tab already attached to this VM is closed first: two terminals racing
 * the same detachproc session (or the same interactive OAuth prompt) is never
 * what the user meant by "open".
 */
export async function openAgentSshTerminalTab(
  input: OpenAgentSshTerminalTabInput,
): Promise<AgentSshTabTarget | null> {
  const { client, session, title, openWorkspaceTarget } = input;
  if (!session.vmResourceId) return null;
  const result = await client.openSession(session.id);
  const target = resourceSshTabTarget(
    session.accountId,
    session.vmResourceId,
    session.pluginId,
    session.resourceTypeId,
    {
      agentSessionId: session.id,
      ...(result.sshKeyId ? { sshKeyId: result.sshKeyId } : {}),
      ...(result.sshKeyName ? { sshKeyName: result.sshKeyName } : {}),
      initialCommand: result.command,
      initialCwd: result.cwd,
    },
  );
  closeSshTabsForAgentTarget(target);
  useUIStore.getState().createWorkspaceTabInstance(target, title);
  openWorkspaceTarget?.(target, title);
  return target;
}

/** Close every open SSH tab pointed at the same VM as `target`. */
export function closeSshTabsForAgentTarget(target: AgentSshTabTarget): void {
  if (target.kind !== "resource") return;
  const state = useUIStore.getState();
  const tabIds = state.workspaceTabs.flatMap((tab) => {
    const existing = tab.target;
    if (existing.kind !== "resource") return [];
    if (existing.view !== "ssh") return [];
    if (existing.accountId !== target.accountId) return [];
    if (existing.resourceId !== target.resourceId) return [];
    return [tab.id];
  });
  if (tabIds.length > 0) state.removeWorkspaceTabs(tabIds);
}
