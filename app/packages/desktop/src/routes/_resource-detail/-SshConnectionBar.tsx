import { useGT } from "gt-react";
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
      <output
        aria-label={gt("SSH connected")}
        className="size-1.5 rounded-full bg-green-500 shrink-0"
      />
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
          className="ml-auto text-xs text-on-surface-faint hover:text-on-surface-secondary transition-colors"
        >
          {gt("Disconnect ✕")}
        </button>
      )}
    </div>
  );
}
