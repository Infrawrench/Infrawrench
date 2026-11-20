import { useEffect, useState } from "react";
import { useGT } from "gt-react";
import type { InfraenvSource, InfraenvSourceOutput } from "@infrawrench/client-core";
import { Modal } from "../components/Modal.js";
import { useDataString } from "../i18n/data-strings.js";
import { dialogClass, inputClass, secondaryButton } from "./styles.js";
import type { EnvFilesClient } from "./types.js";

export interface ResourcePickerModalProps {
  client: EnvFilesClient;
  onPick: (source: InfraenvSource, output: InfraenvSourceOutput) => void;
  onClose: () => void;
}

/**
 * Pick one output of one synced resource: search the organization's
 * resources that declare outputs, then choose the output. Nothing is typed by
 * id; the search box only narrows the list.
 */
export function ResourcePickerModal({ client, onPick, onClose }: ResourcePickerModalProps) {
  const gt = useGT();
  // A string, so the fetch effect depends on its value rather than on `gt`.
  const loadFailed = gt("Failed to load resources");
  const ds = useDataString();
  const [query, setQuery] = useState("");
  const [sources, setSources] = useState<readonly InfraenvSource[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<InfraenvSource | null>(null);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    const timer = setTimeout(
      () => {
        client
          .listSources(query.trim())
          .then((rows) => {
            if (!cancelled) setSources(rows);
          })
          .catch((e) => {
            if (cancelled) return;
            setSources([]);
            setError(e instanceof Error ? e.message : loadFailed);
          });
      },
      query === "" ? 0 : 250,
    );
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [client, query, loadFailed]);

  const heading = gt("Pick a resource output");
  return (
    <Modal onClose={onClose} ariaLabel={heading}>
      <div className={dialogClass}>
        <h2 className="text-sm font-semibold text-on-surface">{heading}</h2>

        {selected === null ? (
          <div className="mt-4 flex flex-col gap-3">
            <input
              type="search"
              autoFocus
              className={inputClass}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={gt("Search by name, type or account")}
              aria-label={gt("Search resources")}
            />
            {error && (
              <p role="alert" className="text-sm text-danger">
                {error}
              </p>
            )}
            {sources === null && !error && (
              <p className="text-sm text-on-surface-faint">{gt("Loading resources…")}</p>
            )}
            {sources !== null && sources.length === 0 && !error && (
              <p className="text-sm text-on-surface-faint">{gt("No resources with outputs.")}</p>
            )}
            {sources !== null && sources.length > 0 && (
              <ul className="max-h-80 overflow-y-auto divide-y divide-border rounded-lg border border-border">
                {sources.map((source) => (
                  <li key={source.resourceId}>
                    <button
                      type="button"
                      onClick={() => setSelected(source)}
                      className="w-full px-3 py-2 text-left hover:bg-surface-sunken"
                    >
                      <span className="block truncate text-sm text-on-surface">
                        {source.displayName}
                      </span>
                      <span className="block truncate text-xs text-on-surface-faint">
                        {ds(source.pluginName)} · {ds(source.resourceTypeName)} ·{" "}
                        {source.accountName}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : (
          <div className="mt-4 flex flex-col gap-3">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="truncate text-sm text-on-surface">{selected.displayName}</p>
                <p className="truncate text-xs text-on-surface-faint">
                  {ds(selected.pluginName)} · {ds(selected.resourceTypeName)} ·{" "}
                  {selected.accountName}
                </p>
              </div>
              <button type="button" className={secondaryButton} onClick={() => setSelected(null)}>
                {gt("Back")}
              </button>
            </div>
            <ul className="max-h-80 overflow-y-auto divide-y divide-border rounded-lg border border-border">
              {selected.outputs.map((output) => (
                <li key={output.key}>
                  <button
                    type="button"
                    onClick={() => onPick(selected, output)}
                    className="flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-surface-sunken"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm text-on-surface">
                        {ds(output.label)}
                      </span>
                      <span className="block truncate font-mono text-xs text-on-surface-faint">
                        {output.key}
                      </span>
                    </span>
                    {output.sensitive && (
                      <span className="shrink-0 rounded border border-border px-1.5 text-[11px] text-on-surface-secondary">
                        {gt("Sensitive")}
                      </span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="mt-4 flex justify-end">
          <button type="button" className={secondaryButton} onClick={onClose}>
            {gt("Cancel")}
          </button>
        </div>
      </div>
    </Modal>
  );
}
