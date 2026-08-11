import { useCallback, useEffect, useState } from "react";

import { CostAnnotationModal } from "../cost/CostAnnotationModal.js";
import {
  describeCostAnnotationScope,
  formatCostAnnotationDates,
  type CostAnnotation,
  type CostAnnotationInput,
} from "../cost/config.js";
import type { CostReportsClient } from "./types.js";

export interface CostAnnotationsSectionProps {
  reportId: string;
  reportName: string;
  client: CostReportsClient;
}

/**
 * The notes drawn on this report's chart, as a list.
 *
 * The chart itself is the fast path — click a bar, write what happened — but a
 * chart only shows the window it is configured for, and a list is where you go
 * to find the note you wrote in March, fix a date, or move one from "this
 * report" to org-wide. It is the same relationship the Reports list has to a
 * dashboard card.
 *
 * Renders nothing at all when the host hasn't wired the annotation reads: a
 * surface without them is the surface that existed before this feature.
 */
export function CostAnnotationsSection({
  reportId,
  reportName,
  client,
}: CostAnnotationsSectionProps) {
  const load = client.listCostAnnotations;
  const [annotations, setAnnotations] = useState<CostAnnotation[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ annotation: CostAnnotation | null } | null>(null);

  const canWrite = Boolean(
    client.createCostAnnotation && client.updateCostAnnotation && client.deleteCostAnnotation,
  );

  const refresh = useCallback(async () => {
    if (!load) return;
    try {
      setAnnotations(await load(reportId));
      setError(null);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [load, reportId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (!load) return null;

  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-on-surface-faint">
          Annotations
        </h3>
        {canWrite && (
          <button
            type="button"
            onClick={() => setEditing({ annotation: null })}
            className="text-xs text-on-surface-faint underline hover:text-on-surface-secondary"
          >
            Add annotation
          </button>
        )}
      </div>

      {error !== null ? (
        <div role="alert" className="text-xs text-red-500">
          Couldn&rsquo;t load annotations — {error}{" "}
          <button type="button" onClick={() => void refresh()} className="underline">
            Retry
          </button>
        </div>
      ) : annotations === null ? (
        <p role="status" className="text-xs text-on-surface-faint">
          Loading annotations…
        </p>
      ) : annotations.length === 0 ? (
        <p className="text-xs text-on-surface-faint">
          No annotations yet. A note dated to the day something happened is what turns a step in
          this chart back into an explanation six weeks from now.
        </p>
      ) : (
        <ul className="flex flex-col divide-y divide-border rounded-lg border border-border">
          {annotations.map((annotation) => (
            <li key={annotation.id} className="flex items-start justify-between gap-3 px-3 py-2">
              <div className="min-w-0">
                <p className="text-sm text-on-surface">{annotation.text}</p>
                <p className="text-[11px] text-on-surface-faint">
                  {formatCostAnnotationDates(annotation)} ·{" "}
                  {/*
                    Said on every row: an org-wide note edited from here changes
                    what every other cost chart in the org shows, and nobody
                    should discover that after saving.
                  */}
                  {describeCostAnnotationScope(annotation)}
                  {/* Where this note came from, when it wasn't written by hand. */}
                  {annotation.costAnomalyId ? " · Explains a detected anomaly" : ""}
                </p>
              </div>
              {canWrite && (
                <button
                  type="button"
                  onClick={() => setEditing({ annotation })}
                  className="shrink-0 text-xs text-on-surface-faint underline hover:text-on-surface-secondary"
                >
                  Edit
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {editing && (
        <CostAnnotationModal
          annotation={editing.annotation}
          defaultStartDate={new Date().toISOString().slice(0, 10)}
          reportId={reportId}
          reportName={reportName}
          onSave={async (input: CostAnnotationInput) => {
            if (editing.annotation) {
              await client.updateCostAnnotation!(editing.annotation.id, input);
            } else {
              await client.createCostAnnotation!(input);
            }
            await refresh();
          }}
          {...(editing.annotation
            ? {
                onDelete: async () => {
                  await client.deleteCostAnnotation!(editing.annotation!.id);
                  await refresh();
                },
              }
            : {})}
          onClose={() => setEditing(null)}
        />
      )}
    </section>
  );
}
