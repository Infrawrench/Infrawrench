import type { QuickSshConnection, SshConfig } from "./types";

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
  return (
    <div className="shrink-0 flex items-center gap-3 px-4 py-2 border-t border-border bg-surface">
      <span
        role="status"
        aria-label="SSH connected"
        className="w-1.5 h-1.5 rounded-full bg-green-500 shrink-0"
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
          onClick={onDisconnect}
          className="ml-auto text-xs text-on-surface-faint hover:text-on-surface-secondary transition-colors"
        >
          Disconnect ✕
        </button>
      )}
    </div>
  );
}
