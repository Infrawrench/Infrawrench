import { useEffect, useState } from "react";
import { SshTerminal } from "../../components/SshTerminal";
import { SshQuickConnectPanel } from "../../components/SshQuickConnectPanel";
import type { QuickSshConnection, SshConfig } from "./-types";

interface SshViewPaneProps {
  accountId: string;
  decodedResourceId: string;
  sshConfig: SshConfig | null;
  sshHost: string | null;
  sshDefaultUsername: string | null;
  quickSshConnection: QuickSshConnection | null;
  onConnect: (config: QuickSshConnection) => void;
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
}: SshViewPaneProps) {
  const storageKey = agentForwardStorageKey(accountId, decodedResourceId);
  const [agentForward, setAgentForward] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return window.localStorage.getItem(storageKey) === "1";
  });

  useEffect(() => {
    setAgentForward(window.localStorage.getItem(storageKey) === "1");
  }, [storageKey]);

  const hasTerminal = !!sshConfig;
  const showToolbar = !hasTerminal && !!sshHost && !quickSshConnection;

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
          />
        ) : sshHost ? (
          <SshQuickConnectPanel
            host={sshHost}
            {...(sshDefaultUsername ? { defaultUsername: sshDefaultUsername } : {})}
            onConnect={onConnect}
          />
        ) : null}
      </div>
    </div>
  );
}

function AgentForwardToolbar({ checked, onChange }: { checked: boolean; onChange: () => void }) {
  return (
    <div className="shrink-0 flex items-center gap-2 px-3 py-1.5 border-b border-border/60 bg-surface/40">
      <label className="flex items-center gap-2 text-xs text-on-surface-muted cursor-pointer select-none">
        <input type="checkbox" checked={checked} onChange={onChange} className="accent-green-600" />
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
