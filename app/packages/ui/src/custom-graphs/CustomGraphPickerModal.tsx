import { useEffect, useState } from "react";
import { T, useGT } from "gt-react";

import { DEFAULT_CUSTOM_GRAPH_SOURCE } from "@infrawrench/client-core";

import { Modal } from "../components/Modal.js";
import type { CustomGraphSummary, CustomGraphsClient } from "./types.js";

export interface CustomGraphPickerModalProps {
  client: CustomGraphsClient;
  /**
   * Add a card for this graph to the dashboard. Called for both an existing
   * pick and a just-created graph.
   */
  onPick: (graph: CustomGraphSummary, created: boolean) => Promise<void> | void;
  onClose: () => void;
  /**
   * Open the script editor for this graph (the picker closes itself first).
   * Present on hosts that can edit — it is what makes a graph with no
   * dashboard card still reachable for editing.
   */
  onEdit?: ((graph: CustomGraphSummary) => void) | undefined;
  /**
   * The graph (and every card showing it, server-side) was deleted — hosts
   * drop any of their own widgets pointing at it.
   */
  onDeleted?: ((graphId: string) => void) | undefined;
  /** Shown instead of the create form when the org isn't on a paid plan. */
  paidPlanNotice?: string | undefined;
}

/**
 * Add a custom graph to the dashboard: pick one the org already has, or
 * create a new one (seeded with a working example script) and open it. A graph
 * is an org object like a budget — many dashboards can show the same one —
 * so this list doubles as the management surface: it is where a graph with no
 * card anywhere can still be edited or deleted.
 */
export function CustomGraphPickerModal({
  client,
  onPick,
  onClose,
  onEdit,
  onDeleted,
  paidPlanNotice,
}: CustomGraphPickerModalProps) {
  const gt = useGT();
  const [graphs, setGraphs] = useState<CustomGraphSummary[] | null>(null);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    client
      .list()
      .then(setGraphs)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, [client]);

  async function pick(graph: CustomGraphSummary, created: boolean) {
    setBusy(true);
    setError(null);
    try {
      await onPick(graph, created);
      onClose();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  async function remove(graph: CustomGraphSummary) {
    if (!client.remove) return;
    if (
      !window.confirm(
        gt('Delete "{name}"? Every dashboard card showing it and its stored data go with it.', {
          name: graph.name,
        }),
      )
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await client.remove(graph.id);
      setGraphs((prev) => (prev ?? []).filter((g) => g.id !== graph.id));
      onDeleted?.(graph.id);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function createNew() {
    if (!client.create || !name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const graph = await client.create({
        name: name.trim(),
        source: DEFAULT_CUSTOM_GRAPH_SOURCE,
      });
      await onPick(graph, true);
      onClose();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  return (
    <Modal onClose={onClose} ariaLabel="Add a custom graph">
      <div className="bg-surface-raised border border-border-strong rounded-xl shadow-2xl w-[440px] p-6">
        <h2 className="text-base font-semibold text-on-surface mb-1">{gt("Add a custom graph")}</h2>
        <T>
          <p className="text-xs text-on-surface-faint mb-4">
            A custom graph is a script that gathers any data — costs, metrics, external APIs — and
            describes its own chart and controls. Write one here or ask the AI to via MCP.
          </p>
        </T>

        {error && (
          <p role="alert" className="text-xs text-danger mb-3">
            {error}
          </p>
        )}

        {graphs === null ? (
          <p role="status" className="text-sm text-on-surface-faint py-4">
            {gt("Loading…")}
          </p>
        ) : graphs.length > 0 ? (
          <ul className="mb-4 max-h-64 overflow-y-auto -mx-2">
            {graphs.map((g) => (
              <li
                key={g.id}
                className="group flex items-center gap-1 rounded-lg hover:bg-surface-sunken"
              >
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void pick(g, false)}
                  className="flex-1 min-w-0 text-left px-2 py-2 disabled:opacity-50"
                >
                  <span className="block text-sm text-on-surface">{g.name}</span>
                  {g.description && (
                    <span className="block text-xs text-on-surface-faint truncate">
                      {g.description}
                    </span>
                  )}
                </button>
                {onEdit && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      onClose();
                      onEdit(g);
                    }}
                    title={gt("Edit {name}", { name: g.name })}
                    aria-label={gt("Edit {name}", { name: g.name })}
                    className="size-6 flex-shrink-0 rounded-full text-on-surface-faint opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 hover:text-on-surface-secondary hover:bg-surface-raised text-xs flex items-center justify-center disabled:opacity-50"
                  >
                    ✎
                  </button>
                )}
                {client.remove && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void remove(g)}
                    title={gt("Delete {name}", { name: g.name })}
                    aria-label={gt("Delete {name}", { name: g.name })}
                    className="size-6 flex-shrink-0 mr-1 rounded-full text-on-surface-faint opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 hover:text-danger hover:bg-surface-raised text-xs flex items-center justify-center disabled:opacity-50"
                  >
                    ✕
                  </button>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-on-surface-faint mb-4">No custom graphs yet.</p>
        )}

        {paidPlanNotice ? (
          <p className="text-xs text-warning/90 border-t border-border pt-3">{paidPlanNotice}</p>
        ) : (
          client.create && (
            <div className="border-t border-border pt-3 flex items-center gap-2">
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void createNew();
                }}
                placeholder="New graph name"
                aria-label="New graph name"
                disabled={busy}
                className="flex-1 bg-surface-sunken border border-border rounded-md px-2.5 py-1.5 text-sm text-on-surface focus:outline-none focus:border-border-strong"
              />
              <button
                type="button"
                onClick={() => void createNew()}
                disabled={busy || !name.trim()}
                className="rounded-md border border-border px-3 py-1.5 text-sm text-on-surface-secondary hover:bg-surface-sunken disabled:opacity-50"
              >
                Create
              </button>
            </div>
          )
        )}
      </div>
    </Modal>
  );
}
