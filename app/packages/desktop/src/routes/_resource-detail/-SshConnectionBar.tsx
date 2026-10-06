import { useGT } from "gt-react";
import { CloseIcon } from "@infrawrench/ui";
import type { QuickSshConnection, SshConfig } from "./-types";

interface SshConnectionBarProps {
  sshConfig: SshConfig | null;
  sshHost: string | null;
  quickSshConnection: QuickSshConnection | null;
  onDisconnect: () => void;
}

export function SshConnectionBar({
  sshConfig,
  sshHost,
  quickSshConnection,
  onDisconnect,
}: SshConnectionBarProps) {
  const gt = useGT();
  return (
    <div className="shrink-0 flex items-center gap-3 px-4 py-2 border-t border-border bg-surface">
      <span className="text-xs font-mono text-on-surface-tertiary">
        {sshConfig
          ? `${sshConfig.username}@${sshConfig.host}:${sshConfig.port}`
          : quickSshConnection && sshHost
            ? `${quickSshConnection.username}@${sshHost}:22`
            : null}
      </span>
      {quickSshConnection && (
        <button
          type="button"
          onClick={onDisconnect}
          className="ml-auto inline-flex items-center gap-1 text-xs text-on-surface-faint hover:text-on-surface-secondary transition-colors"
        >
          {gt("Disconnect")}
          <CloseIcon size={12} />
        </button>
      )}
    </div>
  );
}
