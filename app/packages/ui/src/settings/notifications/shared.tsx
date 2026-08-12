import { useId, isValidElement, cloneElement } from "react";

export const inputClass =
  "w-full bg-surface-overlay border border-border-strong rounded-lg px-3 py-2 text-sm text-on-surface-secondary placeholder:text-on-surface-faint focus:outline-none focus:border-border-strong";

/** Parse a positive integer from a numeric input. Falls back to 1 on empty or
 * non-numeric input so transient typing states don't poison the API payload. */
export function parsePositiveInt(value: string): number {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 ? n : 1;
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  const generatedId = useId();
  const child = isValidElement<{ id?: string }>(children) ? children : null;
  const controlId = child?.props.id ?? generatedId;
  return (
    <div>
      <label htmlFor={controlId} className="block text-xs text-on-surface-tertiary mb-1">
        {label}
      </label>
      {child ? cloneElement(child, { id: controlId }) : children}
      {hint && <p className="text-xs text-on-surface-faint mt-1">{hint}</p>}
    </div>
  );
}
