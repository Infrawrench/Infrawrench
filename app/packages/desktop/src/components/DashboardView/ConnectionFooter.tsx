import { SparklineChart } from "@infrawrench/ui";
import type { CardStatus } from "./types";

export function ConnectionFooter({
  status,
  onConnect,
}: {
  status?: CardStatus | undefined;
  onConnect?: (() => void) | undefined;
}) {
  if (!status) return null;

  if (status.phase === "connecting") {
    return (
      <div className="px-5 py-3 border-t border-border flex items-center gap-2">
        <span className="size-1.5 rounded-full bg-surface-sunken animate-pulse flex-shrink-0" />
        <span className="text-xs text-on-surface-faint">Connecting…</span>
      </div>
    );
  }

  if (status.phase === "error") {
    return (
      <div
        className="px-5 py-3 border-t border-border flex items-center gap-2"
        title={status.error}
      >
        <span className="size-1.5 rounded-full bg-red-500 flex-shrink-0" />
        <span className="text-xs text-danger truncate">{status.error ?? "Connection failed"}</span>
      </div>
    );
  }

  return (
    <div className="px-5 py-3 border-t border-border space-y-1">
      <div className="flex items-center gap-1.5 mb-1">
        <span className="size-1.5 rounded-full bg-blue-400 flex-shrink-0" />
        <span className="text-xs text-on-surface-faint">Connected</span>
      </div>
      {status.stats?.map((stat, index) => {
        const color =
          stat.variant === "status-healthy"
            ? "text-success"
            : stat.variant === "status-degraded"
              ? "text-warning"
              : stat.variant === "status-error"
                ? "text-danger"
                : "text-on-surface-tertiary";
        return (
          <div key={`${stat.label}:${index}`} className="flex justify-between text-xs">
            <span className="text-on-surface-faint">{stat.label}</span>
            <span className={color}>{stat.value}</span>
          </div>
        );
      })}
      {status.sparkline && status.sparkline.length >= 2 && (
        <div className="flex items-center gap-2 mt-2.5">
          <SparklineChart
            points={status.sparkline}
            width={120}
            height={24}
            label={status.sparklineLabel}
          />
          {status.sparklineLabel && (
            <span className="text-[10px] text-on-surface-faint">{status.sparklineLabel}</span>
          )}
        </div>
      )}
      {status.resourceCounts?.map(({ typeLabel, count }) => (
        <div key={typeLabel} className="flex justify-between text-xs">
          <span className="text-on-surface-faint">{typeLabel}</span>
          <span className="text-on-surface-tertiary">{count}</span>
        </div>
      ))}

      {status.sshTarget && onConnect && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onConnect();
          }}
          className="mt-2 w-full flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg bg-green-100 dark:bg-green-950 border border-green-300 dark:border-green-800 hover:bg-green-200 dark:hover:bg-green-900 hover:border-green-400 dark:hover:border-green-700 text-success hover:text-success-strong text-xs font-medium transition-colors"
        >
          <span>⌨</span>
          Connect
        </button>
      )}
    </div>
  );
}
