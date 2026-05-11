import { SftpBrowserPanel } from "../../components/SftpBrowserPanel";
import { SshQuickConnectPanel } from "../../components/SshQuickConnectPanel";
import type { QuickSshConnection, SshConfig } from "./types";

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
      ) : null}
    </div>
  );
}
