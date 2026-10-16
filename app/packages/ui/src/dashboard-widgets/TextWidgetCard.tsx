import { useGT } from "gt-react";
import type { TextWidgetConfig } from "@infrawrench/client-core";
import { ChatMarkdown } from "../chat/ChatMarkdown.js";
import { CloseIcon } from "../components/icons/ChromeIcons.js";

/**
 * A `text` dashboard card: markdown its editors wrote, for headings between
 * sections, context on a chart, links to runbooks.
 *
 * Rendered through the chat's markdown renderer, which is already the
 * sanitising one: react-markdown emits no raw HTML, a link opens in a new
 * window, and an image becomes a link to its URL instead of a request made
 * the moment the dashboard loads.
 */
export function TextWidgetCard({
  title,
  config,
  onEdit,
  onRemove,
}: {
  title: string;
  config: TextWidgetConfig;
  onEdit?: (() => void) | undefined;
  onRemove?: (() => void) | undefined;
}) {
  const gt = useGT();
  const empty = config.markdown.trim() === "";
  return (
    <div className="group relative rounded-2xl border border-border bg-surface-raised hover:border-border-strong transition-colors flex flex-col overflow-hidden min-h-[9rem]">
      <div className="absolute top-2 right-2 flex items-center gap-1 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-all z-10">
        {onEdit && (
          <button
            type="button"
            onClick={onEdit}
            title={gt("Edit text")}
            aria-label={gt("Edit text")}
            className="size-5 rounded-full text-on-surface-faint hover:text-on-surface-secondary hover:bg-surface-sunken text-xs flex items-center justify-center focus-visible:opacity-100"
          >
            ✎
          </button>
        )}
        {onRemove && (
          <button
            type="button"
            onClick={onRemove}
            title={gt("Remove from dashboard")}
            aria-label={gt("Remove from dashboard")}
            className="size-5 rounded-full text-on-surface-faint hover:text-on-surface-secondary hover:bg-surface-sunken text-xs flex items-center justify-center focus-visible:opacity-100"
          >
            <CloseIcon size={12} />
          </button>
        )}
      </div>
      {title && (
        <h3 className="px-5 pt-4 text-base font-semibold text-on-surface leading-tight truncate pr-14">
          {title}
        </h3>
      )}
      <div className={`flex-1 overflow-y-auto px-5 pb-4 ${title ? "pt-2" : "pt-4 pr-12"}`}>
        {empty ? (
          <p className="text-sm text-on-surface-faint">
            {onEdit ? gt("Nothing written yet. Edit this card to add notes.") : gt("No text.")}
          </p>
        ) : (
          <ChatMarkdown text={config.markdown} />
        )}
      </div>
    </div>
  );
}
