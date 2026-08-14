import { useEffect, useState } from "react";
import { useGT } from "gt-react";
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
  /**
   * Where the agent session's managed SSH key lives. Local sessions use an
   * app key from this machine's DB, whose private key we can read; an org's
   * sessions use the org's `infrawrench-agent` key, whose private key never
   * leaves the server, so those connect through the cloud WS proxy instead.
   */
  agentKeyScope?: "app" | "cloud" | undefined;
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
  agentKeyScope = "app",
  agentLaunchError,
}: SshViewPaneProps) {
  const gt = useGT();
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
    // Cloud sessions never fall back to a local key: the org's agent key is
    // what the VM actually trusts, and ensuring a *local* `infrawrench-agent`
    // key here would hand the terminal a key the VM has never seen.
    if (!agentSessionId || sshKeyId || agentKeyScope === "cloud") {
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
  }, [agentSessionId, sshKeyId, agentKeyScope]);

  useEffect(() => {
    if (!sshHost || sshConfig || quickSshConnection || !effectiveSshKeyId || !autoConnectReady)
      return;
    setAutoConnectError(null);
    setAutoConnectPending(true);
    let cancelled = false;
    // An org's agent key has no private half on this machine — SshTerminal
    // dispatches `cloud` key sources through the WS proxy, which signs with
    // the key server-side, so there is nothing to read here.
    const resolvePrivateKey =
      agentKeyScope === "cloud"
        ? Promise.resolve("")
        : invoke<string>("ssh_key_get_private_key", { keyId: effectiveSshKeyId });
    resolvePrivateKey
      .then((privateKey) => {
        if (cancelled) return;
        onConnect({
          username: sshDefaultUsername ?? "root",
          privateKey,
          keySource:
            agentKeyScope === "cloud"
              ? {
                  type: "cloud",
                  sshKeyId: effectiveSshKeyId,
                  name: effectiveSshKeyName ?? effectiveSshKeyId,
                }
              : {
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
    agentKeyScope,
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
            agentTerminal={Boolean(agentSessionId)}
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
            agentTerminal={Boolean(agentSessionId)}
          />
        ) : sshHost && (autoConnectPending || !autoConnectReady) ? (
          <div className="flex h-full items-center justify-center px-4 text-sm text-on-surface-muted">
            {autoConnectReady
              ? gt("Connecting with infrawrench-agent...")
              : gt("Preparing agent SSH session...")}
          </div>
        ) : sshHost ? (
          <>
            {agentLaunchError && (
              <div className="shrink-0 border-b border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-warning">
                {agentLaunchError}
              </div>
            )}
            {autoConnectError && (
              <div className="shrink-0 border-b border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-warning">
                {gt("Could not auto-connect with {keyName}: {error}", {
                  keyName: effectiveSshKeyName ?? gt("the agent key"),
                  error: autoConnectError,
                })}
              </div>
            )}
            <SshQuickConnectPanel
              host={sshHost}
              {...(sshDefaultUsername ? { defaultUsername: sshDefaultUsername } : {})}
              {...(agentKeyScope === "cloud"
                ? {
                    preferredCloudKeyId: effectiveSshKeyId,
                    preferredCloudKeyName: effectiveSshKeyName,
                  }
                : {
                    preferredAppKeyId: effectiveSshKeyId,
                    preferredAppKeyName: effectiveSshKeyName,
                  })}
              onConnect={onConnect}
            />
          </>
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-1 px-4 text-center">
            {agentLaunchError && (
              <div className="mb-2 rounded border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-warning">
                {agentLaunchError}
              </div>
            )}
            <div className="text-sm text-on-surface-muted animate-pulse">
              {gt("Waiting for an SSH address…")}
            </div>
            <div className="text-xs text-on-surface-faint">
              {gt("The server may still be starting up. This view refreshes automatically.")}
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
  const gt = useGT();
  return (
    <div className="shrink-0 flex items-center gap-2 px-3 py-1.5 border-b border-border/60 bg-surface/40">
      <label className="flex items-center gap-2 text-xs text-on-surface-muted cursor-pointer select-none">
        <input
          type="checkbox"
          aria-label={gt("Forward SSH agent")}
          checked={checked}
          onChange={onChange}
          className="accent-green-600"
        />
        <span>{gt("Forward SSH agent")}</span>
      </label>
      <span
        className="text-[10px] text-on-surface-faint"
        title={gt(
          "Forwards the same SSH key you used to log in, so commands like `git clone` on the remote can authenticate with it. A compromised remote could use the forwarded key against other hosts that accept it — only enable for hosts you trust. Takes effect on the next connection.",
        )}
      >
        {gt("(forwards your selected key; applies on next connect)")}
      </span>
    </div>
  );
}
