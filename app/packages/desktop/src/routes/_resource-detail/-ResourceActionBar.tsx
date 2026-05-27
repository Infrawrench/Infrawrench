interface ResourceActionBarProps {
  hasSftpBrowser: boolean;
  hasSshPanel: boolean;
  sshHost: string | null;
  onOpenSftpTab: () => void;
  onOpenSshTab: () => void;
  onShowTunnelModal: () => void;
  onShowDockerSetup: () => void;
  onShowDropSpotlight: () => void;
}

export function ResourceActionBar({
  hasSftpBrowser,
  hasSshPanel,
  sshHost,
  onOpenSftpTab,
  onOpenSshTab,
  onShowTunnelModal,
  onShowDockerSetup,
  onShowDropSpotlight,
}: ResourceActionBarProps) {
  return (
    <div className="shrink-0 flex justify-end gap-2 px-4 py-2 border-b border-border bg-surface">
      {hasSftpBrowser && (
        <button
          type="button"
          onClick={onOpenSftpTab}
          className="px-3 py-1.5 text-xs text-on-surface-muted hover:text-on-surface-secondary border border-border hover:border-border-strong rounded-lg transition-colors"
        >
          Open SFTP tab
        </button>
      )}
      {hasSshPanel && (
        <button
          type="button"
          onClick={onOpenSshTab}
          className="px-3 py-1.5 text-xs text-on-surface-muted hover:text-on-surface-secondary border border-border hover:border-border-strong rounded-lg transition-colors"
        >
          Open SSH tab
        </button>
      )}
      {sshHost && (
        <>
          <button
            type="button"
            onClick={onShowTunnelModal}
            className="px-3 py-1.5 text-xs text-on-surface-muted hover:text-on-surface-secondary border border-border hover:border-border-strong rounded-lg transition-colors"
          >
            Connect service via SSH
          </button>
          <button
            type="button"
            onClick={onShowDockerSetup}
            className="px-3 py-1.5 text-xs text-on-surface-muted hover:text-on-surface-secondary border border-border hover:border-border-strong rounded-lg transition-colors"
          >
            Setup Docker
          </button>
        </>
      )}
      <button
        type="button"
        onClick={onShowDropSpotlight}
        className="px-3 py-1.5 text-xs text-on-surface-muted hover:text-on-surface-secondary border border-border hover:border-border-strong rounded-lg transition-colors"
      >
        Connect resource
      </button>
    </div>
  );
}
