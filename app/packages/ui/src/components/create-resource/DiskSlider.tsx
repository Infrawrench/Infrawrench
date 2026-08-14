import { useGT } from "gt-react";

export function DiskSlider({
  value,
  min,
  max,
  step,
  onChange,
}: {
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (n: number) => void;
}) {
  const gt = useGT();
  const pct = ((value - min) / (max - min)) * 100;

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs text-on-surface-muted">{gt("{value} GB", { value: min })}</span>
        <span className="text-sm font-medium text-on-surface-secondary">
          {gt("{value} GB", { value })}
        </span>
        <span className="text-xs text-on-surface-muted">{gt("{value} GB", { value: max })}</span>
      </div>
      <div className="relative h-6 flex items-center">
        <div className="absolute w-full h-1.5 bg-surface-sunken rounded-full">
          <div className="absolute h-full bg-blue-500 rounded-full" style={{ width: `${pct}%` }} />
        </div>
        <input
          type="range"
          aria-label={gt("Disk size in GB")}
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
          className="absolute w-full appearance-none bg-transparent cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-blue-500 [&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-blue-300 [&::-webkit-slider-thumb]:shadow-md"
        />
      </div>
    </div>
  );
}
