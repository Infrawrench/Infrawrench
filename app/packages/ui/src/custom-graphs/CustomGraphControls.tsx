import type { CustomGraphControl, CustomGraphControlState } from "./types.js";

export interface CustomGraphControlsProps {
  controls: CustomGraphControl[];
  /** Fired with the whole next state when a value control changes. */
  onChange: (state: CustomGraphControlState) => void;
  /** Fired when a declared button is pressed. */
  onButton: (id: string) => void;
  disabled?: boolean | undefined;
}

/** Current values as the script resolved them, for seeding the next request. */
export function controlStateOf(controls: CustomGraphControl[]): CustomGraphControlState {
  const state: CustomGraphControlState = {};
  for (const c of controls) {
    if (c.kind !== "button") state[c.id] = c.value;
  }
  return state;
}

/**
 * The controls a graph script declared, rendered in declaration order.
 * Value changes and button presses both re-run the script server-side; this
 * component only reports intent.
 */
export function CustomGraphControls({
  controls,
  onChange,
  onButton,
  disabled,
}: CustomGraphControlsProps) {
  if (controls.length === 0) return null;

  const set = (id: string, value: string | number | boolean) => {
    onChange({ ...controlStateOf(controls), [id]: value });
  };

  const inputClass =
    "bg-surface-sunken border border-border rounded-md px-2 py-1 text-xs text-on-surface " +
    "focus:outline-none focus:border-border-strong disabled:opacity-50";

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-5 pb-2">
      {controls.map((c) => {
        switch (c.kind) {
          case "select":
            return (
              <label key={c.id} className="flex items-center gap-1.5 text-xs text-on-surface-faint">
                {c.label}
                <select
                  value={c.value}
                  disabled={disabled}
                  onChange={(e) => set(c.id, e.target.value)}
                  className={inputClass}
                >
                  {c.options.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </label>
            );
          case "checkbox":
            return (
              <label key={c.id} className="flex items-center gap-1.5 text-xs text-on-surface-faint">
                <input
                  type="checkbox"
                  checked={c.value}
                  disabled={disabled}
                  onChange={(e) => set(c.id, e.target.checked)}
                  className="accent-current"
                />
                {c.label}
              </label>
            );
          case "text":
            return (
              <label key={c.id} className="flex items-center gap-1.5 text-xs text-on-surface-faint">
                {c.label}
                <input
                  type="text"
                  defaultValue={c.value}
                  placeholder={c.placeholder}
                  disabled={disabled}
                  onBlur={(e) => {
                    if (e.target.value !== c.value) set(c.id, e.target.value);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                  }}
                  className={`${inputClass} w-28`}
                />
              </label>
            );
          case "number":
            return (
              <label key={c.id} className="flex items-center gap-1.5 text-xs text-on-surface-faint">
                {c.label}
                <input
                  type="number"
                  defaultValue={c.value}
                  min={c.min}
                  max={c.max}
                  step={c.step}
                  disabled={disabled}
                  onBlur={(e) => {
                    const value = Number(e.target.value);
                    if (Number.isFinite(value) && value !== c.value) set(c.id, value);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                  }}
                  className={`${inputClass} w-20`}
                />
              </label>
            );
          case "button":
            return (
              <button
                key={c.id}
                type="button"
                disabled={disabled}
                onClick={() => {
                  if (c.danger && !window.confirm(`${c.label}?`)) return;
                  onButton(c.id);
                }}
                className={
                  "rounded-md border px-2.5 py-1 text-xs transition-colors disabled:opacity-50 " +
                  (c.danger
                    ? "border-red-500/40 text-danger hover:bg-red-500/10"
                    : "border-border text-on-surface-secondary hover:bg-surface-sunken")
                }
              >
                {c.label}
              </button>
            );
        }
      })}
    </div>
  );
}
