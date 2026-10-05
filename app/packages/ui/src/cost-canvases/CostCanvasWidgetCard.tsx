import { useEffect, useState } from "react";
import { useGT } from "gt-react";
import type {
  CostCanvas,
  CostCanvasRunResult,
  CostCanvasWidgetConfig,
} from "@infrawrench/client-core";
import { CloseIcon } from "../components/icons/ChromeIcons.js";
import { CostCanvasView } from "./CostCanvasView.js";
import type { CostCanvasesClient } from "./types.js";

export interface CostCanvasWidgetCardProps {
  config: CostCanvasWidgetConfig;
  client: CostCanvasesClient;
  /** Open the canvas's own page, where it is edited. */
  onOpenCanvas?: ((canvasId: string) => void) | undefined;
  onRemove?: (() => void) | undefined;
}

/**
 * A dashboard card that renders a cost canvas. Not editable in place: the
 * canvas is shared, so its edits belong on its own page (the cost report
 * card's rule). Runs the canvas on mount; charts query live like any card.
 */
export function CostCanvasWidgetCard({
  config,
  client,
  onOpenCanvas,
  onRemove,
}: CostCanvasWidgetCardProps) {
  const gt = useGT();
  const [canvas, setCanvas] = useState<CostCanvas | null>(null);
  const [result, setResult] = useState<CostCanvasRunResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      client.getCanvas(config.canvasId),
      client.runCanvas(config.canvasId, { includeChartData: false }),
    ])
      .then(([c, r]) => {
        if (cancelled) return;
        setCanvas(c);
        setResult(r);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [client, config.canvasId]);

  return (
    <div className="group relative rounded-2xl border border-border bg-surface-raised p-3 flex flex-col gap-3 min-h-[18rem]">
      <div className="flex items-center justify-between gap-2 px-1">
        <span className="truncate text-sm font-semibold text-on-surface">
          {canvas?.name ?? gt("Canvas")}
        </span>
        <div className="flex items-center gap-2">
          {onOpenCanvas && (
            <button
              type="button"
              onClick={() => onOpenCanvas(config.canvasId)}
              className="text-xs text-on-surface-faint hover:text-on-surface-secondary underline"
            >
              {gt("Open")}
            </button>
          )}
          {onRemove && (
            <button
              type="button"
              onClick={onRemove}
              title={gt("Remove from dashboard")}
              aria-label={gt("Remove from dashboard")}
              className="size-5 rounded-full text-on-surface-faint hover:text-on-surface-secondary hover:bg-surface-sunken text-xs flex items-center justify-center opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-all"
            >
              <CloseIcon size={12} />
            </button>
          )}
        </div>
      </div>
      {error ? (
        <div className="flex-1 flex items-center justify-center px-6 text-center text-sm text-on-surface-faint">
          {gt("This canvas is unavailable: {error}", { error })}
        </div>
      ) : canvas ? (
        <CostCanvasView spec={canvas.spec} result={result} api={client} compact />
      ) : (
        <div className="text-sm text-on-surface-faint px-1 animate-pulse">{gt("Loading…")}</div>
      )}
    </div>
  );
}
