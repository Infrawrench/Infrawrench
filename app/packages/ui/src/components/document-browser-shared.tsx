import { useState } from "react";
import { formatErrorMessage } from "../utils.js";

/**
 * The pieces the Mongo and Firestore document browsers render identically.
 *
 * Both browsers are the same shell — a collection sidebar, an insert editor,
 * an expandable row per document with inline JSON editing — differing only in
 * the command protocol behind `onCommand` and in how a document names itself
 * (`_id` vs the Firestore `_name` path). What differs stays in each browser;
 * what is shared lives here, unexported from the package index because it is
 * an implementation detail of those two components.
 */

/**
 * One collection in the sidebar, with its inline drop/delete confirmation.
 * `verb` is the provider's own word for removal — "Drop" for Mongo, "Delete"
 * for Firestore — used for the confirmation prompt and both button labels.
 */
export function CollectionListItem({
  name,
  active,
  confirming,
  verb,
  onSelect,
  onRequestRemove,
  onConfirmRemove,
  onCancelRemove,
}: {
  name: string;
  active: boolean;
  confirming: boolean;
  verb: "Drop" | "Delete";
  onSelect: () => void;
  onRequestRemove: () => void;
  onConfirmRemove: () => void;
  onCancelRemove: () => void;
}) {
  return (
    <div className="group relative">
      {confirming ? (
        <div className="flex items-center gap-1 px-2 py-1.5">
          <span className="text-xs text-danger truncate flex-1">
            {verb} {name}?
          </span>
          <button
            type="button"
            onClick={onConfirmRemove}
            className="px-1.5 py-0.5 rounded bg-red-600 text-xs text-white hover:bg-red-500 transition-colors flex-shrink-0"
          >
            {verb}
          </button>
          <button
            type="button"
            onClick={onCancelRemove}
            className="px-1.5 py-0.5 rounded text-xs text-on-surface-faint hover:text-on-surface-secondary transition-colors flex-shrink-0"
          >
            Cancel
          </button>
        </div>
      ) : (
        <>
          <button
            type="button"
            onClick={onSelect}
            className={`w-full text-left px-3 py-1.5 text-xs truncate transition-colors pr-7 ${
              active
                ? "bg-accent-muted text-accent-on-muted font-medium"
                : "text-on-surface-tertiary hover:text-on-surface-secondary hover:bg-surface-overlay"
            }`}
          >
            {name}
          </button>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onRequestRemove();
            }}
            className="absolute right-1.5 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 text-on-surface-faint hover:text-danger transition-all text-xs px-1"
            title={`${verb} collection`}
            aria-label={`${verb} collection`}
          >
            ×
          </button>
        </>
      )}
    </div>
  );
}

/** The "Insert Document into <collection>" editor both browsers open inline. */
export function InsertDocumentPanel({
  collection,
  text,
  error,
  onTextChange,
  onCancel,
  onSubmit,
}: {
  collection: string;
  text: string;
  error: string | null;
  onTextChange: (text: string) => void;
  onCancel: () => void;
  onSubmit: () => void;
}) {
  return (
    <div className="p-3 border-b border-border/60 bg-surface/80">
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs text-on-surface-tertiary font-medium">
          Insert Document into <span className="text-on-surface-secondary">{collection}</span>
        </span>
        <button
          type="button"
          onClick={onCancel}
          className="text-xs text-on-surface-faint hover:text-on-surface-tertiary transition-colors"
        >
          Cancel
        </button>
      </div>
      <textarea
        value={text}
        onChange={(e) => onTextChange(e.target.value)}
        rows={6}
        aria-label="Document JSON to insert"
        className="w-full bg-surface-raised border border-border-strong rounded-lg px-3 py-2 text-xs text-on-surface-secondary font-mono placeholder:text-on-surface-faint focus:outline-none focus:border-blue-500 resize-y"
        spellCheck={false}
        placeholder='{ "key": "value" }'
      />
      {error && <div className="text-xs text-danger mt-1">{error}</div>}
      <div className="flex justify-end mt-2">
        <button
          type="button"
          onClick={onSubmit}
          className="px-3 py-1.5 rounded bg-blue-600 text-xs text-white hover:bg-blue-500 transition-colors"
        >
          Insert Document
        </button>
      </div>
    </div>
  );
}

/**
 * One expandable document row: collapsed preview line, expanded pretty-printed
 * JSON, and an inline JSON editor behind the Edit button.
 *
 * The browser supplies what its protocol knows: `idLabel` is the document's
 * display identity (a formatted `_id`, a Firestore document id; empty when
 * there is none), `hiddenKey` is the identity field stripped from the preview
 * and from the editable JSON (it is immutable on both stores), and
 * `formatPreview` renders a field value into the collapsed line.
 */
export function DocumentRow({
  doc,
  index,
  idLabel,
  hiddenKey,
  panelIdPrefix,
  formatPreview,
  expanded,
  onToggle,
  onDelete,
  onSave,
}: {
  doc: Record<string, unknown>;
  index: number;
  idLabel: string;
  hiddenKey: string;
  panelIdPrefix: string;
  formatPreview: (val: unknown) => string;
  expanded: boolean;
  onToggle: () => void;
  onDelete: () => void;
  onSave: (docJson: string) => Promise<void>;
}) {
  const previewFields = Object.entries(doc)
    .filter(([k]) => k !== hiddenKey)
    .slice(0, 4);

  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState("");
  const [editError, setEditError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  function startEdit() {
    const { [hiddenKey]: _removed, ...rest } = doc;
    setEditText(JSON.stringify(rest, null, 2));
    setEditError(null);
    setEditing(true);
  }

  async function handleSave() {
    setEditError(null);
    let parsed: unknown;
    try {
      parsed = JSON.parse(editText);
    } catch {
      setEditError("Invalid JSON");
      return;
    }
    setSaving(true);
    try {
      await onSave(JSON.stringify(parsed));
      setEditing(false);
    } catch (e) {
      setEditError(formatErrorMessage(e));
    } finally {
      setSaving(false);
    }
  }

  const panelId = `${panelIdPrefix}-${index}${idLabel ? `-${idLabel}` : ""}`;

  return (
    <div className="group">
      <div className="flex items-center gap-3 px-3 py-2 hover:bg-surface-overlay/30 transition-colors">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          aria-controls={panelId}
          className="flex items-center gap-3 flex-1 min-w-0 text-left cursor-pointer"
        >
          <span
            aria-hidden="true"
            className={`text-on-surface-faint text-xs transition-transform flex-shrink-0 ${expanded ? "rotate-90" : ""}`}
          >
            &#9654;
          </span>
          <span className="text-xs text-on-surface-muted w-8 flex-shrink-0 text-right font-mono">
            {index}
          </span>
          {idLabel && (
            <span className="text-xs text-accent/70 font-mono flex-shrink-0 truncate max-w-[160px]">
              {idLabel}
            </span>
          )}
          <div className="flex-1 min-w-0 flex items-center gap-3 overflow-hidden">
            {previewFields.map(([key, val]) => (
              <span key={key} className="text-xs truncate flex-shrink">
                <span className="text-on-surface-faint">{key}:</span>{" "}
                <span className="text-on-surface-tertiary">{formatPreview(val)}</span>
              </span>
            ))}
          </div>
        </button>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            startEdit();
            if (!expanded) onToggle();
          }}
          className="opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 text-xs text-on-surface-faint hover:text-info px-1 transition-all flex-shrink-0"
          title="Edit document"
          aria-label={idLabel ? `Edit document ${idLabel}` : "Edit document"}
        >
          Edit
        </button>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
          className="opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 text-xs text-on-surface-faint hover:text-danger px-1 transition-all flex-shrink-0"
          title="Delete document"
          aria-label={idLabel ? `Delete document ${idLabel}` : "Delete document"}
        >
          Delete
        </button>
      </div>
      {expanded && (
        <div id={panelId} className="px-12 pb-3">
          {editing ? (
            <div className="space-y-2">
              <textarea
                value={editText}
                onChange={(e) => setEditText(e.target.value)}
                rows={10}
                aria-label="Document JSON"
                className="w-full bg-surface-raised border border-border-strong rounded-lg px-3 py-2 text-xs text-on-surface-secondary font-mono focus:outline-none focus:border-blue-500 resize-y"
                spellCheck={false}
              />
              {editError && <div className="text-xs text-danger">{editError}</div>}
              <div className="flex gap-2 justify-end">
                <button
                  type="button"
                  onClick={() => setEditing(false)}
                  className="px-2.5 py-1 rounded text-xs text-on-surface-faint hover:text-on-surface-secondary transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => void handleSave()}
                  disabled={saving}
                  className="px-3 py-1 rounded bg-blue-600 text-xs text-white hover:bg-blue-500 disabled:opacity-50 transition-colors"
                >
                  {saving ? "Saving…" : "Save"}
                </button>
              </div>
            </div>
          ) : (
            <pre className="text-xs font-mono text-on-surface-secondary bg-surface-raised/50 rounded-lg p-3 overflow-x-auto whitespace-pre-wrap break-words">
              {JSON.stringify(doc, null, 2)}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
