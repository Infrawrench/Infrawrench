import { useCallback, useEffect, useRef, useState } from "react";

import type {
  CustomGraphControlState,
  CustomGraphRenderResult,
  CustomGraphWidgetConfig,
  CustomGraphsClient,
} from "./types.js";
import { CustomGraphChart } from "./CustomGraphChart.js";
import { CustomGraphControls, controlStateOf } from "./CustomGraphControls.js";
import { useStableGT } from "../i18n/stable-gt.js";

export interface CustomGraphCardProps {
  title: string;
  config: CustomGraphWidgetConfig;
  client: CustomGraphsClient;
  /** Open the script editor (hidden when the host is read-only). */
  onEditScript?: (() => void) | undefined;
  onRemove?: (() => void) | undefined;
  /** Bumped by the editor after a save so the card re-renders fresh. */
  reloadToken?: number | undefined;
}

/**
 * A dashboard card for one custom graph: runs the script server-side, draws
 * the returned chart, renders the declared controls, and re-runs on control
 * changes, button presses, and the script's own refreshSeconds.
 */
export function CustomGraphCard({
  title,
  config,
  client,
  onEditScript,
  onRemove,
  reloadToken,
}: CustomGraphCardProps) {
  // Stable: `run` below is a dependency of the mount effect, so an identity
  // that changes every render turns one card into an endless render loop.
  const gt = useStableGT();
  const [result, setResult] = useState<CustomGraphRenderResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);
  // Sticky across renders so a select choice survives a refresh tick.
  const stateRef = useRef<CustomGraphControlState | undefined>(undefined);
  const generation = useRef(0);

  const run = useCallback(
    async (trigger: "manual" | "refresh" | "interaction" = "manual", button?: string) => {
      const gen = ++generation.current;
      setBusy(true);
      setError(null);
      try {
        const next = await client.render(config.graphId, {
          ...(stateRef.current ? { controls: stateRef.current } : {}),
          ...(button ? { button } : {}),
          trigger,
        });
        if (gen !== generation.current) return;
        setResult(next);
        if (next.spec) stateRef.current = controlStateOf(next.spec.controls);
      } catch (e: unknown) {
        if (gen !== generation.current) return;
        setError(e instanceof Error ? e.message : gt("Failed to render graph"));
      } finally {
        if (gen === generation.current) setBusy(false);
      }
    },
    [client, config.graphId, gt],
  );

  useEffect(() => {
    void run();
    return () => {
      // Invalidate in-flight renders on unmount/config change.
      generation.current += 1;
    };
  }, [run, reloadToken]);

  // The script's own refresh policy. Paused while a render is in flight.
  const refreshSeconds = result?.spec?.refreshSeconds;
  useEffect(() => {
    if (!refreshSeconds || busy) return;
    const timer = setTimeout(() => void run("refresh"), refreshSeconds * 1000);
    return () => clearTimeout(timer);
  }, [refreshSeconds, busy, run, result]);

  const spec = result?.spec ?? null;
  const scriptError = result && !result.ok ? result.error : null;

  return (
    <div className="group relative rounded-2xl border border-border bg-surface-raised hover:border-border-strong transition-colors flex flex-col overflow-hidden min-h-[18rem]">
      <div className="absolute top-2 right-2 flex items-center gap-1 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-all z-10">
        {onEditScript && (
          <button
            type="button"
            onClick={onEditScript}
            title={gt("Edit graph script")}
            aria-label={gt("Edit graph script")}
            className="size-5 rounded-full text-on-surface-faint hover:text-on-surface-secondary hover:bg-surface-sunken text-xs flex items-center justify-center"
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
            className="size-5 rounded-full text-on-surface-faint hover:text-on-surface-secondary hover:bg-surface-sunken text-xs flex items-center justify-center"
          >
            ✕
          </button>
        )}
      </div>

      <div className="px-5 pt-4 pb-1">
        <div className="flex items-baseline gap-2 pr-14">
          <h3 className="text-base font-semibold text-on-surface leading-tight truncate">
            {spec?.title || title || gt("Custom graph")}
          </h3>
          {busy && result && (
            <span className="text-[10px] text-on-surface-faint flex-shrink-0" role="status">
              {gt("refreshing…")}
            </span>
          )}
        </div>
      </div>

      {spec && (
        <CustomGraphControls
          controls={spec.controls}
          disabled={busy}
          onChange={(state) => {
            stateRef.current = state;
            void run("interaction");
          }}
          onButton={(id) => void run("interaction", id)}
        />
      )}

      <div className="flex-1 min-h-0 px-3 pb-2 flex flex-col">
        {error || scriptError ? (
          <div
            role="alert"
            className="flex-1 flex items-center justify-center text-sm text-danger px-4 text-center whitespace-pre-wrap"
          >
            {error ?? scriptError}
          </div>
        ) : spec ? (
          <CustomGraphChart spec={spec.chart} />
        ) : (
          <div
            role="status"
            className="flex-1 flex items-center justify-center text-sm text-on-surface-faint"
          >
            {gt("Running graph…")}
          </div>
        )}
      </div>

      {spec?.notice && <p className="px-5 pb-3 text-[11px] text-on-surface-faint">{spec.notice}</p>}
    </div>
  );
}
