import { useCallback, useEffect, useState } from "react";
import type { ArtifactEntry, ArtifactRegistryCapability } from "@infrawrench/plugin-base";
import { formatBytes } from "@infrawrench/plugin-base";

export interface ArtifactListParams {
  pageToken?: string;
  prefix?: string;
}

export interface ArtifactListResult {
  items: ArtifactEntry[];
  nextPageToken?: string;
}

interface Props {
  capability: ArtifactRegistryCapability;
  onListArtifacts: (params: ArtifactListParams) => Promise<ArtifactListResult>;
}

function formatTimestamp(iso: string | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

function truncateDigest(digest: string | undefined): string {
  if (!digest) return "";
  const short = digest.replace(/^sha\d+:/, "");
  return short.length > 12 ? short.slice(0, 12) : short;
}

export function ArtifactRegistryView({ capability, onListArtifacts }: Props) {
  const [prefix, setPrefix] = useState(capability.defaultPrefix ?? "");
  const [items, setItems] = useState<ArtifactEntry[]>([]);
  const [nextPageToken, setNextPageToken] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [initialized, setInitialized] = useState(false);

  const load = useCallback(
    async (opts: { reset: boolean; pageToken?: string; prefixOverride?: string }) => {
      const activePrefix = opts.prefixOverride ?? prefix;
      if (opts.reset) {
        setLoading(true);
      } else {
        setLoadingMore(true);
      }
      setError(null);
      try {
        const params: ArtifactListParams = {};
        if (opts.pageToken) params.pageToken = opts.pageToken;
        if (activePrefix) params.prefix = activePrefix;
        const result = await onListArtifacts(params);
        setItems((prev) => (opts.reset ? result.items : [...prev, ...result.items]));
        setNextPageToken(result.nextPageToken);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
        setLoadingMore(false);
        setInitialized(true);
      }
    },
    [onListArtifacts, prefix],
  );

  useEffect(() => {
    void load({ reset: true, prefixOverride: capability.defaultPrefix ?? "" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const showTagsColumn = capability.supportsTags ?? false;
  const versionHeader = showTagsColumn ? "Tags" : "Version";

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="shrink-0 px-4 py-3 border-b border-border flex gap-2 items-center">
        <input
          type="text"
          value={prefix}
          onChange={(e) => setPrefix(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void load({ reset: true });
          }}
          placeholder="Filter by prefix…"
          className="flex-1 px-3 py-1.5 rounded text-sm bg-surface-overlay border border-border text-on-surface placeholder:text-on-surface-faint focus:outline-none focus:border-border-strong"
        />
        <button
          onClick={() => void load({ reset: true })}
          disabled={loading}
          className="px-3 py-1.5 text-xs font-medium rounded-md bg-surface-overlay hover:bg-surface-sunken text-on-surface-secondary border border-border disabled:opacity-50 transition-colors"
        >
          {loading ? "Loading…" : "Reload"}
        </button>
      </div>

      {error && (
        <div className="shrink-0 px-4 py-2 border-b border-border bg-red-500/10 text-red-400 text-xs font-mono whitespace-pre-wrap">
          {error}
        </div>
      )}

      <div className="flex-1 overflow-auto">
        {!initialized && loading ? (
          <div className="flex items-center justify-center py-16 text-on-surface-faint text-sm">
            Loading artifacts…
          </div>
        ) : items.length === 0 && !loading ? (
          <div className="flex items-center justify-center py-16 text-on-surface-faint text-sm">
            No artifacts found.
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-surface-sunken border-b border-border z-10">
              <tr>
                <th className="px-4 py-2 text-left font-medium text-on-surface-muted uppercase text-xs tracking-wide">
                  Name
                </th>
                <th className="px-4 py-2 text-left font-medium text-on-surface-muted uppercase text-xs tracking-wide">
                  {versionHeader}
                </th>
                <th className="px-4 py-2 text-left font-medium text-on-surface-muted uppercase text-xs tracking-wide">
                  Size
                </th>
                <th className="px-4 py-2 text-left font-medium text-on-surface-muted uppercase text-xs tracking-wide">
                  Digest
                </th>
                <th className="px-4 py-2 text-left font-medium text-on-surface-muted uppercase text-xs tracking-wide">
                  Updated
                </th>
              </tr>
            </thead>
            <tbody>
              {items.map((item, i) => (
                <tr
                  key={`${item.name}:${item.digest ?? item.version ?? i}`}
                  className="border-b border-border hover:bg-surface-raised/40"
                >
                  <td className="px-4 py-2 text-on-surface">{item.name}</td>
                  <td className="px-4 py-2 text-on-surface-secondary">
                    {showTagsColumn
                      ? item.tags && item.tags.length > 0
                        ? item.tags.join(", ")
                        : "—"
                      : (item.version ?? "—")}
                  </td>
                  <td className="px-4 py-2 text-on-surface-tertiary">
                    {item.sizeBytes != null && item.sizeBytes > 0
                      ? formatBytes(item.sizeBytes)
                      : "—"}
                  </td>
                  <td
                    className="px-4 py-2 font-mono text-xs text-on-surface-tertiary"
                    title={item.digest ?? ""}
                  >
                    {truncateDigest(item.digest)}
                  </td>
                  <td className="px-4 py-2 text-xs text-on-surface-tertiary">
                    {formatTimestamp(item.updatedAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {nextPageToken && (
        <div className="shrink-0 px-4 py-2 border-t border-border flex justify-center">
          <button
            onClick={() => void load({ reset: false, pageToken: nextPageToken })}
            disabled={loadingMore}
            className="px-4 py-1.5 text-xs font-medium rounded-md bg-surface-overlay hover:bg-surface-sunken text-on-surface-secondary border border-border disabled:opacity-50 transition-colors"
          >
            {loadingMore ? "Loading…" : "Load more"}
          </button>
        </div>
      )}
    </div>
  );
}
