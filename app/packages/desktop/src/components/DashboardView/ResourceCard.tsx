import { extractHostLabel } from "@infrawrench/ui";
import { ConnectionFooter } from "./ConnectionFooter";
import type { CardStatus, PinnedRow, PluginMeta } from "./types";

export function ResourceCard({
  row,
  pluginMeta,
  status,
  onOpen,
  onUnpin,
  onConnect,
}: {
  row: PinnedRow;
  pluginMeta?: PluginMeta | undefined;
  status?: CardStatus | undefined;
  onOpen: () => void;
  onUnpin: () => void;
  onConnect?: (() => void) | undefined;
}) {
  const fields = (() => {
    try {
      return JSON.parse(row.fields_json) as Record<string, unknown>;
    } catch {
      return {};
    }
  })();

  const host = extractHostLabel(fields);

  return (
    <div className="group relative rounded-2xl border border-border bg-surface-raised hover:border-border-strong transition-colors flex flex-col overflow-hidden">
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onUnpin();
        }}
        title="Remove from dashboard"
        className="absolute top-2 right-2 size-5 rounded-full text-on-surface-faint hover:text-on-surface-secondary hover:bg-surface-sunken transition-all opacity-0 group-hover:opacity-100 text-xs flex items-center justify-center"
      >
        ✕
      </button>

      <button type="button" onClick={onOpen} className="flex-1 flex flex-col p-5 text-left gap-3">
        <div className="flex items-center gap-2">
          {pluginMeta?.logoSvg ? (
            <div
              className="size-6 flex-shrink-0"
              dangerouslySetInnerHTML={{ __html: pluginMeta.logoSvg }}
            />
          ) : (
            <span className="text-xs text-on-surface-faint font-mono">{row.plugin_id}</span>
          )}
          <span className="text-xs text-on-surface-muted">
            {pluginMeta?.displayName ?? row.plugin_id}
          </span>
        </div>

        <div>
          <p className="text-base font-semibold text-on-surface leading-tight">
            {row.display_name}
          </p>
          {host && <p className="text-xs text-on-surface-muted mt-0.5 truncate">{host}</p>}
        </div>
      </button>

      <ConnectionFooter status={status} onConnect={onConnect} />
    </div>
  );
}
