export const selectBaseClass =
  "rounded-lg border border-border bg-surface-sunken px-2.5 py-1.5 text-sm text-on-surface focus:outline-none focus:border-blue-500";
export const selectClass = `w-full ${selectBaseClass}`;
export const labelClass = "block text-xs font-medium text-on-surface-secondary mb-1";

/** Rows/Query tab button styling — one string per state, no component state. */
export const tabClass = (active: boolean) =>
  `rounded-md px-2 py-0.5 text-xs transition-colors ${
    active
      ? "bg-surface-sunken text-on-surface"
      : "text-on-surface-faint hover:text-on-surface-secondary"
  }`;
