import { useMemo } from "react";
import { T } from "gt-react";

import { AppLauncherHostPanel } from "../../components/AppsPanels";
import { SshQuickConnectPanel } from "../../components/SshQuickConnectPanel";
import type { AppsConnectConfig } from "../../lib/apps-session";
import type { QuickSshConnection, SshConfig } from "./-types";

/**
 * The Apps view of a resource: pick a key the same way the SSH tab does, then
 * show the host's launcher.
 *
 * The key choice is deliberately the same flow rather than a second one —
 * running an application on a host is the same act of access as opening a
 * shell on it, and it should ask for the same thing in the same way.
 */
export interface AppsViewPaneProps {
  accountId: string;
  decodedResourceId: string;
  /** The host's plugin and type — each window tab is addressed at its URL. */
  pluginId?: string | undefined;
  resourceTypeId?: string | undefined;
  sshConfig: SshConfig | null;
  sshHost: string | null;
  sshDefaultUsername: string | null;
  quickSshConnection: QuickSshConnection | null;
  onConnect: (config: QuickSshConnection) => void;
}

export function AppsViewPane({
  accountId,
  decodedResourceId,
  pluginId,
  resourceTypeId,
  sshConfig,
  sshHost,
  sshDefaultUsername,
  quickSshConnection,
  onConnect,
}: AppsViewPaneProps) {
  const config = useMemo<AppsConnectConfig | null>(() => {
    const host = sshHost ?? sshConfig?.host ?? null;
    if (!host || !quickSshConnection) return null;
    // A cloud-held key never leaves the server, so it cannot be used from the
    // renderer's own SSH connection; the cloud path handles those instead.
    if (quickSshConnection.keySource.type === "cloud") return null;
    return {
      host,
      port: sshConfig?.port ?? 22,
      username: quickSshConnection.username,
      privateKey: quickSshConnection.privateKey,
    };
  }, [sshHost, sshConfig, quickSshConnection]);

  if (!sshHost && !sshConfig?.host) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-center">
        <p className="max-w-md text-sm text-on-surface-muted">
          <T>
            This resource has no address to connect to yet. Applications run over the same SSH
            connection as the terminal.
          </T>
        </p>
      </div>
    );
  }

  if (!config) {
    return (
      <div className="h-full overflow-y-auto p-4">
        {quickSshConnection?.keySource.type === "cloud" && (
          <p className="mb-3 text-sm text-on-surface-muted">
            <T>
              This key is held in Infrawrench Cloud, so its private half never reaches this machine.
              Applications need a key stored locally — choose another below.
            </T>
          </p>
        )}
        <SshQuickConnectPanel
          host={sshHost ?? sshConfig?.host ?? ""}
          defaultUsername={sshDefaultUsername ?? "root"}
          onConnect={onConnect}
        />
      </div>
    );
  }

  return (
    <AppLauncherHostPanel
      accountId={accountId}
      resourceId={decodedResourceId}
      {...(pluginId ? { pluginId } : {})}
      {...(resourceTypeId ? { resourceTypeId } : {})}
      config={config}
    />
  );
}
