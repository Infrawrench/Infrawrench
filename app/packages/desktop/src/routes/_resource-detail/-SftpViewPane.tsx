import { SftpBrowserPanel } from "../../components/SftpBrowserPanel";
import { SshQuickConnectPanel } from "../../components/SshQuickConnectPanel";
import type { QuickSshConnection, SshConfig } from "./-types";

interface SftpViewPaneProps {
  activeCloudOrgId: string | null;
  accountId: string;
  decodedResourceId: string;
  sshHost: string | null;
  sshDefaultUsername: string | null;
  sshConfig: SshConfig | null;
  quickSshConnection: QuickSshConnection | null;
  onConnect: (config: QuickSshConnection) => void;
}

export function SftpViewPane({
  activeCloudOrgId,
  accountId,
  decodedResourceId,
  sshHost,
  sshDefaultUsername,
  sshConfig,
  quickSshConnection,
  onConnect,
}: SftpViewPaneProps) {
  return (
    <div className="flex-1 min-h-0 overflow-hidden flex flex-col">
      {activeCloudOrgId && sshHost && quickSshConnection ? (
        <SftpBrowserPanel
          cloudContext={{
            orgId: activeCloudOrgId,
            accountId,
            resourceId: decodedResourceId,
            sshHost,
            sshUsername: quickSshConnection.username,
            ...(quickSshConnection.keySource.type === "cloud"
              ? { sshKeyId: quickSshConnection.keySource.sshKeyId }
              : {}),
          }}
          initialPath="/"
        />
      ) : activeCloudOrgId && !sshHost ? (
        <SftpBrowserPanel
          cloudContext={{
            orgId: activeCloudOrgId,
            accountId,
            resourceId: decodedResourceId,
          }}
          initialPath="/"
        />
      ) : sshConfig ? (
        <SftpBrowserPanel sftpConfig={sshConfig} initialPath="/" />
      ) : sshHost && quickSshConnection ? (
        <SftpBrowserPanel
          sftpConfig={{
            host: sshHost,
            port: 22,
            username: quickSshConnection.username,
            privateKey: quickSshConnection.privateKey,
          }}
          initialPath="/"
        />
      ) : sshHost ? (
        <SshQuickConnectPanel
          host={sshHost}
          {...(sshDefaultUsername ? { defaultUsername: sshDefaultUsername } : {})}
          onConnect={onConnect}
        />
      ) : (
        <div className="flex h-full flex-col items-center justify-center gap-1 px-4 text-center">
          <div className="text-sm text-on-surface-muted animate-pulse">
            Waiting for an SSH address…
          </div>
          <div className="text-xs text-on-surface-faint">
            The server may still be starting up. This view refreshes automatically.
          </div>
        </div>
      )}
    </div>
  );
}
