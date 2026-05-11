interface ResourceFooterBarProps {
  canDelete: boolean;
  hasCredentialFormats: boolean;
  resourceTypeLabel: string;
  onShowExportCredential: () => void;
  onConfirmDelete: () => void;
}

export function ResourceFooterBar({
  canDelete,
  hasCredentialFormats,
  resourceTypeLabel,
  onShowExportCredential,
  onConfirmDelete,
}: ResourceFooterBarProps) {
  return (
    <div className="shrink-0 px-4 py-2 border-t border-border flex items-center justify-end gap-3">
      {hasCredentialFormats && (
        <button
          onClick={onShowExportCredential}
          className="text-xs text-on-surface-faint hover:text-on-surface-secondary transition-colors px-2 py-1 rounded hover:bg-surface-overlay"
        >
          Get credentials…
        </button>
      )}
      {canDelete && (
        <button
          onClick={onConfirmDelete}
          className="text-xs text-on-surface-faint hover:text-red-400 transition-colors px-2 py-1 rounded hover:bg-red-500/10"
        >
          Delete {resourceTypeLabel}…
        </button>
      )}
    </div>
  );
}
