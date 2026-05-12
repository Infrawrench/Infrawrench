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

export function SshViewPane({
  accountId,
  decodedResourceId,
  sshConfig,
  sshHost,
  sshDefaultUsername,
  quickSshConnection,
  onConnect,
}: SshViewPaneProps) {
  const hasTerminal = !!sshConfig;
  return (
    <div className="flex-1 min-h-0 overflow-hidden">
      {hasTerminal && sshConfig ? (
        <SshTerminal
          host={sshConfig.host}
          port={sshConfig.port}
          username={sshConfig.username}
          privateKey={sshConfig.privateKey}
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
        />
      ) : sshHost ? (
        <SshQuickConnectPanel
          host={sshHost}
          {...(sshDefaultUsername ? { defaultUsername: sshDefaultUsername } : {})}
          onConnect={onConnect}
        />
      ) : null}
    </div>
  );
}
