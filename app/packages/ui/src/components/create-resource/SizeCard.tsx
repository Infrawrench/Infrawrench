import type { SizeOption } from "@infrawrench/plugin-base";

export function SizeCard({ size, selected, maxMemory, maxCpu, onSelect }: {
  size: SizeOption;
  selected: boolean;
  maxMemory: number;
  maxCpu: number;
  onSelect: () => void;
}) {
  const memPct = Math.max(4, Math.round((size.memoryMb / maxMemory) * 100));
  const cpuPct = Math.max(4, Math.round((size.vcpus / maxCpu) * 100));
  const memLabel = size.memoryMb >= 1024 ? `${(size.memoryMb / 1024).toFixed(size.memoryMb % 1024 === 0 ? 0 : 1)} GB` : `${size.memoryMb} MB`;

  return (
    <button
      onClick={onSelect}
      className={`text-left p-3 rounded-lg border transition-all ${
        selected
          ? "border-blue-500 bg-blue-600/10"
          : "border-gray-700 bg-gray-800/50 hover:border-gray-600"
      }`}
    >
      <p className={`text-xs font-mono font-medium mb-2 truncate ${selected ? "text-blue-300" : "text-gray-300"}`}>
        {size.label}
      </p>

      {/* CPU bar */}
      <div className="mb-1.5">
        <div className="flex justify-between mb-0.5">
          <span className="text-[10px] text-gray-600">CPU</span>
          <span className="text-[10px] text-gray-500">{size.vcpus} vCPU{size.vcpus !== 1 ? "s" : ""}</span>
        </div>
        <div className="h-1 bg-gray-700 rounded-full overflow-hidden">
          <div
            className={`h-full rounded-full transition-all ${selected ? "bg-blue-500" : "bg-gray-500"}`}
            style={{ width: `${cpuPct}%` }}
          />
        </div>
      </div>

      {/* RAM bar */}
      <div className="mb-2">
        <div className="flex justify-between mb-0.5">
          <span className="text-[10px] text-gray-600">RAM</span>
          <span className="text-[10px] text-gray-500">{memLabel}</span>
        </div>
        <div className="h-1 bg-gray-700 rounded-full overflow-hidden">
          <div
            className={`h-full rounded-full transition-all ${selected ? "bg-blue-400" : "bg-gray-500"}`}
            style={{ width: `${memPct}%` }}
          />
        </div>
      </div>

      <div className="flex items-center justify-between">
        {size.diskGb != null && (
          <span className="text-[10px] text-gray-600">{size.diskGb} GB disk</span>
        )}
        {size.priceMonthly != null && (
          <span className={`text-[10px] ml-auto ${selected ? "text-blue-400" : "text-gray-500"}`}>
            ${size.priceMonthly}/mo
          </span>
        )}
      </div>
    </button>
  );
}
