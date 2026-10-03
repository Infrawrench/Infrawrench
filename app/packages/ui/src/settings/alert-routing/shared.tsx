import { useGT } from "gt-react";

/* -------------------------------------------------------------------------- */
/* Small shared bits                                                          */
/* -------------------------------------------------------------------------- */

export const INPUT =
  "rounded-md border border-border bg-surface px-2 py-1 text-sm text-on-surface-secondary";

export function minutesToTime(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

export function timeToMinutes(value: string): number {
  const [h, m] = value.split(":").map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return 0;
  return Math.min(1439, Math.max(0, (h ?? 0) * 60 + (m ?? 0)));
}

/**
 * The browser's own zone as the default for a new quiet-hours window. Almost
 * always what the person filling in the form means, and a wrong guess is
 * visible in the field rather than hidden in a default nobody sees.
 */
export function localTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

export const WEEKDAY_ISOS = [1, 2, 3, 4, 5, 6, 7] as const;

export function useWeekdayLabels(): Record<(typeof WEEKDAY_ISOS)[number], string> {
  const gt = useGT();
  return {
    1: gt("Mon"),
    2: gt("Tue"),
    3: gt("Wed"),
    4: gt("Thu"),
    5: gt("Fri"),
    6: gt("Sat"),
    7: gt("Sun"),
  };
}
