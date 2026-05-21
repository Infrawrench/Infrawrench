interface ResourceFooterBarProps {
  canDelete: boolean;
  canEdit: boolean;
  hasCredentialFormats: boolean;
  resourceTypeLabel: string;
  onShowExportCredential: () => void;
  onConfirmDelete: () => void;
  onEdit: () => void;
}

export function ResourceFooterBar({
  canDelete,
  canEdit,
  hasCredentialFormats,
  resourceTypeLabel,
  onShowExportCredential,
  onConfirmDelete,
  onEdit,
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
      {canEdit && (
        <button
          onClick={onEdit}
          className="text-xs text-on-surface-faint hover:text-on-surface-secondary transition-colors px-2 py-1 rounded hover:bg-surface-overlay"
        >
          Edit {resourceTypeLabel}…
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
