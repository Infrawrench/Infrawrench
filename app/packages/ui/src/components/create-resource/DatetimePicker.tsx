import type { DatetimeMode } from "@infrawrench/plugin-base";

const INPUT_CLASSES =
  "w-full bg-surface-overlay border border-border-strong rounded-lg px-3 py-2 text-sm text-on-surface-secondary placeholder:text-on-surface-faint focus:outline-none focus:border-blue-500";

const pad = (n: number) => n.toString().padStart(2, "0");

function parseToDate(value: string, mode: DatetimeMode): Date | null {
  if (!value) return null;
  if (mode === "epoch-ms") {
    const ms = Number(value);
    if (!Number.isFinite(ms)) return null;
    return new Date(ms);
  }
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function dateToInputValue(d: Date, mode: DatetimeMode): string {
  const y = d.getUTCFullYear();
  const m = pad(d.getUTCMonth() + 1);
  const day = pad(d.getUTCDate());
  if (mode === "date") return `${y}-${m}-${day}`;
  return `${y}-${m}-${day}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

function inputValueToStored(inputValue: string, mode: DatetimeMode): string {
  if (!inputValue) return "";
  if (mode === "date") return inputValue;
  const utc = new Date(`${inputValue}:00Z`);
  if (Number.isNaN(utc.getTime())) return "";
  if (mode === "epoch-ms") return String(utc.getTime());
  return `${inputValue}:00Z`;
}

export function DatetimePicker({
  value,
  onChange,
  mode = "datetime",
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  mode?: DatetimeMode;
  placeholder?: string;
}) {
  const parsed = parseToDate(value, mode);
  const inputValue = parsed ? dateToInputValue(parsed, mode) : "";

  return (
    <div className="space-y-1.5">
      <input
        type={mode === "date" ? "date" : "datetime-local"}
        value={inputValue}
        onChange={(e) => onChange(inputValueToStored(e.target.value, mode))}
        placeholder={placeholder}
        className={INPUT_CLASSES}
        aria-label={mode === "date" ? "Date" : "Date and time"}
      />
      {mode !== "date" && (
        <p className="text-[11px] text-on-surface-faint">
          Interpreted as UTC{parsed && ` · stored as ${formatStoredHint(parsed, mode)}`}
        </p>
      )}
    </div>
  );
}

function formatStoredHint(d: Date, mode: DatetimeMode): string {
  if (mode === "epoch-ms") return `${d.getTime()} ms`;
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}
