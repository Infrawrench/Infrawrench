/** Class strings the environment files panel and its dialogs share. */
/** A field with no width of its own, for controls that set one (`w-48`): `w-full` would win. */
export const fieldClass =
  "rounded-lg border border-border bg-surface-sunken px-2.5 py-1.5 text-sm text-on-surface focus:outline-none focus:border-accent-subtle disabled:opacity-60";
export const inputClass = `w-full ${fieldClass}`;
export const labelClass = "block text-xs font-medium text-on-surface-secondary mb-1";
export const primaryButton =
  "rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-on-accent hover:bg-accent-hover disabled:opacity-50";
export const secondaryButton =
  "rounded-lg border border-border bg-surface-raised px-3 py-1.5 text-sm text-on-surface hover:border-border-strong disabled:opacity-50";
export const quietButton =
  "rounded-lg px-2 py-1 text-xs text-on-surface-secondary hover:bg-surface-sunken transition-colors disabled:opacity-50";
export const dialogClass =
  "w-[32rem] max-w-[92vw] rounded-2xl border border-border bg-surface p-5 shadow-xl";
