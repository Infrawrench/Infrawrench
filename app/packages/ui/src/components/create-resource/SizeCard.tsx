import { useGT } from "gt-react";
import type { SizeOption } from "@infrawrench/plugin-base";

export function SizeCard({
  size,
  selected,
  maxMemory,
  maxCpu,
  onSelect,
}: {
  size: SizeOption;
  selected: boolean;
  maxMemory: number;
  maxCpu: number;
  onSelect: () => void;
}) {
  const gt = useGT();
  const memPct = Math.max(4, Math.round((size.memoryMb / maxMemory) * 100));
  const cpuPct = Math.max(4, Math.round((size.vcpus / maxCpu) * 100));
  const memLabel =
    size.memoryMb >= 1024
      ? gt("{value} GB", {
          value: (size.memoryMb / 1024).toFixed(size.memoryMb % 1024 === 0 ? 0 : 1),
        })
      : gt("{value} MB", { value: size.memoryMb });

  return (
    <button
      type="button"
      onClick={onSelect}
      className={`text-left p-3 rounded-lg border transition-all ${
        selected
          ? "border-blue-500 bg-accent-muted"
          : "border-border-strong bg-surface-overlay/50 hover:border-border-strong"
      }`}
    >
      <p
        className={`text-xs font-mono font-medium mb-2 truncate ${selected ? "text-accent-on-muted" : "text-on-surface-secondary"}`}
      >
        {size.label}
      </p>

      {/* CPU bar */}
      <div className="mb-1.5">
        <div className="flex justify-between mb-0.5">
          <span className="text-[10px] text-on-surface-faint">{gt("CPU")}</span>
          <span className="text-[10px] text-on-surface-muted">
            {size.vcpus === 1
              ? gt("{count} vCPU", { count: size.vcpus })
              : gt("{count} vCPUs", { count: size.vcpus })}
          </span>
        </div>
        <div className="h-1 bg-surface-sunken rounded-full overflow-hidden">
          <div
            className={`h-full rounded-full transition-all ${selected ? "bg-blue-500" : "bg-surface-sunken"}`}
            style={{ width: `${cpuPct}%` }}
          />
        </div>
      </div>

      {/* RAM bar */}
      <div className="mb-2">
        <div className="flex justify-between mb-0.5">
          <span className="text-[10px] text-on-surface-faint">{gt("RAM")}</span>
          <span className="text-[10px] text-on-surface-muted">{memLabel}</span>
        </div>
        <div className="h-1 bg-surface-sunken rounded-full overflow-hidden">
          <div
            className={`h-full rounded-full transition-all ${selected ? "bg-blue-400" : "bg-surface-sunken"}`}
            style={{ width: `${memPct}%` }}
          />
        </div>
      </div>

      <div className="flex items-center justify-between">
        {size.diskGb != null && (
          <span className="text-[10px] text-on-surface-faint">
            {gt("{size} GB disk", { size: size.diskGb })}
          </span>
        )}
        {size.priceMonthly != null && size.priceMonthly > 0 && (
          <span
            className={`text-[10px] ml-auto ${selected ? "text-accent" : "text-on-surface-muted"}`}
          >
            {gt("${amount}/mo", { amount: size.priceMonthly })}
          </span>
        )}
      </div>
    </button>
  );
}
