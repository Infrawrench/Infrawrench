// Agent SSH launch metadata resolution for web resource tabs.
//
// An SSH tab opened for an agent session carries launch metadata (managed key
// + launch command/cwd) on its workspace-tab target. That metadata survives
// in-app navigation but not deep links or restored tabs — the URL only
// carries `?agentSession=...`. When pieces are missing we rehydrate them from
// the server (POST /agents/sessions/:id/open) and gate auto-connect until the
// resolution settles. Mirrors desktop's ResourcePanel agent-launch resolution.

import type { AgentLaunchDefaults } from "@infrawrench/ui/agents";

export type { AgentLaunchDefaults } from "@infrawrench/ui/agents";
export { NO_AGENT_LAUNCH_DEFAULTS } from "@infrawrench/ui/agents";

/**
 * Key identifying an agent-launch lookup that still needs server resolution.
 * Returns null when no lookup should run — CRITICALLY, plain SSH views
 * (no agentSessionId) must never trigger a session lookup: a VM that once
 * hosted an agent session would otherwise silently attach the agent's screen.
 */
export function agentLaunchLookupKey(params: {
  isSshView: boolean;
  accountId: string;
  resourceId: string;
  agentSessionId?: string | undefined;
  sshKeyId?: string | undefined;
  sshKeyName?: string | undefined;
  initialCommand?: string | undefined;
  initialCwd?: string | undefined;
}): string | null {
  const {
    isSshView,
    accountId,
    resourceId,
    agentSessionId,
    sshKeyId,
    sshKeyName,
    initialCommand,
    initialCwd,
  } = params;
  return isSshView && agentSessionId && !(sshKeyId && sshKeyName && initialCommand && initialCwd)
    ? `${accountId}:${resourceId}:${agentSessionId}`
    : null;
}

interface EffectiveAgentLaunch {
  agentSessionId?: string | undefined;
  sshKeyId?: string | undefined;
  sshKeyName?: string | undefined;
  initialCommand?: string | undefined;
  initialCwd?: string | undefined;
  /** False while agent metadata is still resolving — auto-connect must wait. */
  autoConnectReady: boolean;
}

/**
 * Merge URL/tab-provided launch metadata with server-resolved defaults.
 * When resolution failed, drop the agent fields entirely so the pane falls
 * back to the ordinary quick-connect panel instead of waiting forever.
 */
export function resolveEffectiveAgentLaunch(params: {
  agentSessionId?: string | undefined;
  sshKeyId?: string | undefined;
  sshKeyName?: string | undefined;
  initialCommand?: string | undefined;
  initialCwd?: string | undefined;
  defaults: AgentLaunchDefaults;
  resolving: boolean;
  failed: boolean;
}): EffectiveAgentLaunch {
  const {
    agentSessionId,
    sshKeyId,
    sshKeyName,
    initialCommand,
    initialCwd,
    defaults,
    resolving,
    failed,
  } = params;
  const effectiveAgentSessionId = failed ? undefined : agentSessionId;
  const effectiveInitialCommand = failed ? undefined : (initialCommand ?? defaults.initialCommand);
  const effectiveInitialCwd = failed ? undefined : (initialCwd ?? defaults.initialCwd);
  return {
    agentSessionId: effectiveAgentSessionId,
    sshKeyId: failed ? undefined : (sshKeyId ?? defaults.sshKeyId),
    sshKeyName: failed ? undefined : (sshKeyName ?? defaults.sshKeyName),
    initialCommand: effectiveInitialCommand,
    initialCwd: effectiveInitialCwd,
    autoConnectReady:
      !resolving &&
      (!effectiveAgentSessionId || Boolean(effectiveInitialCommand && effectiveInitialCwd)),
  };
}
