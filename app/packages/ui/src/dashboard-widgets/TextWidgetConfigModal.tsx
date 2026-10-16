import { useId, useState } from "react";
import { useGT } from "gt-react";
import { TEXT_WIDGET_LIMITS, type TextWidgetConfig } from "@infrawrench/client-core";
import { Modal } from "../components/Modal.js";
import { ChatMarkdown } from "../chat/ChatMarkdown.js";
import { labelClass, selectClass, tabClass } from "../cost/form-styles.js";

/** Write or edit a text card: a title and markdown, with a preview. */
export function TextWidgetConfigModal({
  initialTitle,
  initialConfig,
  onSave,
  onClose,
}: {
  initialTitle: string;
  initialConfig: TextWidgetConfig;
  onSave: (title: string, config: TextWidgetConfig) => Promise<void> | void;
  onClose: () => void;
}) {
  const gt = useGT();
  const uid = useId();
  const [title, setTitle] = useState(initialTitle);
  const [markdown, setMarkdown] = useState(initialConfig.markdown);
  const [tab, setTab] = useState<"write" | "preview">("write");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const tooLong = markdown.length > TEXT_WIDGET_LIMITS.maxLength;

  async function submit() {
    if (tooLong) return;
    setBusy(true);
    setError(null);
    try {
      await onSave(title.trim(), { version: 1, markdown });
      onClose();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  return (
    <Modal onClose={onClose} ariaLabel={gt("Text card")}>
      <div className="bg-surface-raised border border-border-strong rounded-xl shadow-2xl w-[560px] max-w-full p-6 flex flex-col gap-3">
        <h2 className="text-base font-semibold text-on-surface">{gt("Text card")}</h2>
        <div>
          <label htmlFor={`${uid}-title`} className={labelClass}>
            {gt("Title (optional)")}
          </label>
          <input
            id={`${uid}-title`}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className={selectClass}
          />
        </div>
        <div className="flex flex-col gap-1">
          <div className="flex items-center justify-between">
            <label htmlFor={`${uid}-markdown`} className={labelClass}>
              {gt("Text")}
            </label>
            <div role="tablist" aria-label={gt("Editor view")} className="flex gap-1">
              <button
                type="button"
                role="tab"
                aria-selected={tab === "write"}
                onClick={() => setTab("write")}
                className={tabClass(tab === "write")}
              >
                {gt("Write")}
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={tab === "preview"}
                onClick={() => setTab("preview")}
                className={tabClass(tab === "preview")}
              >
                {gt("Preview")}
              </button>
            </div>
          </div>
          {tab === "write" ? (
            <textarea
              id={`${uid}-markdown`}
              value={markdown}
              onChange={(e) => setMarkdown(e.target.value)}
              rows={12}
              aria-describedby={`${uid}-hint`}
              className={`${selectClass} font-mono text-xs leading-relaxed resize-y`}
            />
          ) : (
            <div
              role="tabpanel"
              className="min-h-[14rem] max-h-[24rem] overflow-y-auto rounded-lg border border-border bg-surface px-3 py-2"
            >
              {markdown.trim() ? (
                <ChatMarkdown text={markdown} />
              ) : (
                <p className="text-sm text-on-surface-faint">{gt("Nothing to preview yet.")}</p>
              )}
            </div>
          )}
          <p id={`${uid}-hint`} className="text-[11px] text-on-surface-faint">
            {gt(
              "Markdown: # headings, **bold**, - lists, [links](https://example.com) and `code`. Raw HTML is not rendered.",
            )}
          </p>
          <p className={`text-[11px] ${tooLong ? "text-danger" : "text-on-surface-faint"}`}>
            {gt("{count} of {max} characters", {
              count: markdown.length,
              max: TEXT_WIDGET_LIMITS.maxLength,
            })}
          </p>
        </div>
        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-border px-3 py-1.5 text-sm text-on-surface"
          >
            {gt("Cancel")}
          </button>
          <button
            type="button"
            disabled={busy || tooLong}
            onClick={() => void submit()}
            className="rounded-lg bg-blue-600 px-3 py-1.5 text-sm text-white disabled:opacity-50"
          >
            {gt("Save")}
          </button>
        </div>
      </div>
    </Modal>
  );
}
