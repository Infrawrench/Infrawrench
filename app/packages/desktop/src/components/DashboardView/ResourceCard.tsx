import { useGT } from "gt-react";
import { buildResourceShowcase, omitLiveShowcaseStats } from "@infrawrench/plugin-base";
import { useDataString, CloseIcon, ResourceTypeIcon, ShowcaseLines } from "@infrawrench/ui";
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
  const gt = useGT();
  const gtData = useDataString();
  const fields = (() => {
    try {
      return JSON.parse(row.fields_json) as Record<string, unknown>;
    } catch {
      return {};
    }
  })();

  return (
    <div className="group relative rounded-2xl border border-border bg-surface-raised hover:border-border-strong transition-colors flex flex-col overflow-hidden">
      <ResourceTypeIcon
        iconKey={pluginMeta?.iconKeys[row.resource_type_id]}
        size={136}
        strokeWidth={1.25}
        className="pointer-events-none absolute -right-[68px] -top-[68px] text-on-surface opacity-[0.1]"
      />
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onUnpin();
        }}
        title={gt("Remove from dashboard")}
        aria-label={gt("Remove from dashboard")}
        className="absolute top-2 right-2 size-5 rounded-full text-on-surface-faint hover:text-on-surface-secondary hover:bg-surface-sunken transition-all opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 text-xs flex items-center justify-center"
      >
        <CloseIcon size={12} />
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
            {pluginMeta?.displayName ? gtData(pluginMeta.displayName) : row.plugin_id}
          </span>
        </div>

        <div>
          <p className="text-base font-semibold text-on-surface leading-tight">
            {row.display_name}
          </p>
        </div>
        <span className="flex flex-col">
          <ShowcaseLines
            showcase={omitLiveShowcaseStats(
              buildResourceShowcase(fields, pluginMeta?.showcases[row.resource_type_id]),
              status?.stats,
            )}
          />
        </span>
      </button>

      <ConnectionFooter status={status} onConnect={onConnect} />
    </div>
  );
}
