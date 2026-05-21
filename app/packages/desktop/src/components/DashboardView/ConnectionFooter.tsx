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
        <span className="w-1.5 h-1.5 rounded-full bg-surface-sunken animate-pulse flex-shrink-0" />
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
        <span className="w-1.5 h-1.5 rounded-full bg-red-500 flex-shrink-0" />
        <span className="text-xs text-red-500 truncate">{status.error ?? "Connection failed"}</span>
      </div>
    );
  }

  return (
    <div className="px-5 py-3 border-t border-border space-y-1">
      <div className="flex items-center gap-1.5 mb-1">
        <span className="w-1.5 h-1.5 rounded-full bg-blue-400 flex-shrink-0" />
        <span className="text-xs text-on-surface-faint">Connected</span>
      </div>
      {status.stats?.map((stat, index) => {
        const color =
          stat.variant === "status-healthy"
            ? "text-green-400"
            : stat.variant === "status-degraded"
              ? "text-yellow-400"
              : stat.variant === "status-error"
                ? "text-red-400"
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
          <SparklineChart points={status.sparkline} width={120} height={24} />
          {status.sparklineLabel && (
            <span className="text-[10px] text-on-surface-faint">{status.sparklineLabel}</span>
          )}
        </div>
      )}
      {status.resourceCounts?.map(({ typeLabel, count }, index) => (
        <div key={`${typeLabel}:${index}`} className="flex justify-between text-xs">
          <span className="text-on-surface-faint">{typeLabel}</span>
          <span className="text-on-surface-tertiary">{count}</span>
        </div>
      ))}

      {status.sshTarget && onConnect && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onConnect();
          }}
          className="mt-2 w-full flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg bg-green-100 dark:bg-green-950 border border-green-300 dark:border-green-800 hover:bg-green-200 dark:hover:bg-green-900 hover:border-green-400 dark:hover:border-green-700 text-green-700 dark:text-green-400 hover:text-green-800 dark:hover:text-green-300 text-xs font-medium transition-colors"
        >
          <span>⌨</span>
          Connect
        </button>
      )}
    </div>
  );
}
