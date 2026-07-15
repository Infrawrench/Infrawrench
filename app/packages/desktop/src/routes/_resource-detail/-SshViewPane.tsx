import { useEffect, useState } from "react";
import { SshTerminal } from "../../components/SshTerminal";
import { SshQuickConnectPanel } from "../../components/SshQuickConnectPanel";
import { invoke } from "../../lib/invoke";
import type { QuickSshConnection, SshConfig } from "./-types";

interface SshViewPaneProps {
  accountId: string;
  decodedResourceId: string;
  sshConfig: SshConfig | null;
  sshHost: string | null;
  sshDefaultUsername: string | null;
  quickSshConnection: QuickSshConnection | null;
  onConnect: (config: QuickSshConnection) => void;
  agentSessionId?: string | undefined;
  sshKeyId?: string | undefined;
  sshKeyName?: string | undefined;
  initialCommand?: string | undefined;
  initialCwd?: string | undefined;
  autoConnectReady?: boolean | undefined;
  /** Agent launch metadata failed to resolve — show why and fall back to quick connect. */
  agentLaunchError?: string | undefined;
}

function agentForwardStorageKey(accountId: string, resourceId: string): string {
  return `ssh:agentForward:${accountId}:${resourceId}`;
}

export function SshViewPane({
  accountId,
  decodedResourceId,
  sshConfig,
  sshHost,
  sshDefaultUsername,
  quickSshConnection,
  onConnect,
  agentSessionId,
  sshKeyId,
  sshKeyName,
  initialCommand,
  initialCwd,
  autoConnectReady = true,
  agentLaunchError,
}: SshViewPaneProps) {
  const storageKey = agentForwardStorageKey(accountId, decodedResourceId);
  const [autoConnectError, setAutoConnectError] = useState<string | null>(null);
  const [autoConnectPending, setAutoConnectPending] = useState(false);
  const [resolvedAgentKey, setResolvedAgentKey] = useState<{
    id: string;
    name: string;
  } | null>(null);
  const [agentForward, setAgentForward] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return window.localStorage.getItem(storageKey) === "1";
  });

  const effectiveSshKeyId = sshKeyId ?? resolvedAgentKey?.id;
  const effectiveSshKeyName = sshKeyName ?? resolvedAgentKey?.name;

  useEffect(() => {
    setAgentForward(window.localStorage.getItem(storageKey) === "1");
  }, [storageKey]);

  useEffect(() => {
    if (!agentSessionId || sshKeyId) {
      setResolvedAgentKey(null);
      return;
    }
    let cancelled = false;
    invoke<{ id: string; name: string; publicKey: string }>("ssh_key_ensure_agent_key")
      .then((key) => {
        if (!cancelled) setResolvedAgentKey({ id: key.id, name: key.name });
      })
      .catch((error) => {
        console.warn(`Failed to resolve managed agent SSH key for ${agentSessionId}`, error);
        if (!cancelled) setResolvedAgentKey(null);
      });
    return () => {
      cancelled = true;
    };
  }, [agentSessionId, sshKeyId]);

  useEffect(() => {
    if (!sshHost || sshConfig || quickSshConnection || !effectiveSshKeyId || !autoConnectReady)
      return;
    setAutoConnectError(null);
    setAutoConnectPending(true);
    let cancelled = false;
    invoke<string>("ssh_key_get_private_key", { keyId: effectiveSshKeyId })
      .then((privateKey) => {
        if (cancelled) return;
        onConnect({
          username: sshDefaultUsername ?? "root",
          privateKey,
          keySource: {
            type: "app",
            id: effectiveSshKeyId,
            name: effectiveSshKeyName ?? effectiveSshKeyId,
          },
        });
      })
      .catch((error) => {
        console.warn(`Failed to auto-connect SSH tab with key ${effectiveSshKeyId}`, error);
        if (!cancelled) setAutoConnectError(formatErrorMessage(error));
      })
      .finally(() => {
        if (!cancelled) setAutoConnectPending(false);
      });
    return () => {
      cancelled = true;
    };
  }, [
    sshHost,
    sshConfig,
    quickSshConnection,
    effectiveSshKeyId,
    effectiveSshKeyName,
    sshDefaultUsername,
    onConnect,
    autoConnectReady,
  ]);

  const hasTerminal = !!sshConfig;
  const showToolbar =
    !hasTerminal && !!sshHost && !quickSshConnection && !autoConnectPending && autoConnectReady;

  function toggleAgentForward() {
    setAgentForward((prev) => {
      const next = !prev;
      window.localStorage.setItem(storageKey, next ? "1" : "0");
      return next;
    });
  }

  return (
    <div className="flex-1 min-h-0 overflow-hidden flex flex-col">
      {showToolbar && <AgentForwardToolbar checked={agentForward} onChange={toggleAgentForward} />}
      <div className="flex-1 min-h-0 overflow-hidden">
        {hasTerminal && sshConfig ? (
          <SshTerminal
            host={sshConfig.host}
            port={sshConfig.port}
            username={sshConfig.username}
            privateKey={sshConfig.privateKey}
            agentForward={agentForward}
            initialCommand={initialCommand}
            initialCwd={initialCwd}
          />
        ) : sshHost && quickSshConnection ? (
          <SshTerminal
            host={sshHost}
            port={22}
            username={quickSshConnection.username}
            privateKey={quickSshConnection.privateKey}
            keySource={quickSshConnection.keySource}
            accountId={accountId}
            resourceId={decodedResourceId}
            agentForward={agentForward}
            initialCommand={initialCommand}
            initialCwd={initialCwd}
          />
        ) : sshHost && (autoConnectPending || !autoConnectReady) ? (
          <div className="flex h-full items-center justify-center px-4 text-sm text-on-surface-muted">
            {autoConnectReady
              ? "Connecting with infrawrench-agent..."
              : "Preparing agent SSH session..."}
          </div>
        ) : sshHost ? (
          <>
            {agentLaunchError && (
              <div className="shrink-0 border-b border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
                {agentLaunchError}
              </div>
            )}
            {autoConnectError && (
              <div className="shrink-0 border-b border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
                Could not auto-connect with {effectiveSshKeyName ?? "the agent key"}:{" "}
                {autoConnectError}
              </div>
            )}
            <SshQuickConnectPanel
              host={sshHost}
              {...(sshDefaultUsername ? { defaultUsername: sshDefaultUsername } : {})}
              preferredAppKeyId={effectiveSshKeyId}
              preferredAppKeyName={effectiveSshKeyName}
              onConnect={onConnect}
            />
          </>
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-1 px-4 text-center">
            {agentLaunchError && (
              <div className="mb-2 rounded border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
                {agentLaunchError}
              </div>
            )}
            <div className="text-sm text-on-surface-muted animate-pulse">
              Waiting for an SSH address…
            </div>
            <div className="text-xs text-on-surface-faint">
              The server may still be starting up. This view refreshes automatically.
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function formatErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function AgentForwardToolbar({ checked, onChange }: { checked: boolean; onChange: () => void }) {
  return (
    <div className="shrink-0 flex items-center gap-2 px-3 py-1.5 border-b border-border/60 bg-surface/40">
      <label className="flex items-center gap-2 text-xs text-on-surface-muted cursor-pointer select-none">
        <input
          type="checkbox"
          aria-label="Forward SSH agent"
          checked={checked}
          onChange={onChange}
          className="accent-green-600"
        />
        <span>Forward SSH agent</span>
      </label>
      <span
        className="text-[10px] text-on-surface-faint"
        title="Forwards the same SSH key you used to log in, so commands like `git clone` on the remote can authenticate with it. A compromised remote could use the forwarded key against other hosts that accept it — only enable for hosts you trust. Takes effect on the next connection."
      >
        (forwards your selected key; applies on next connect)
      </span>
    </div>
  );
}
