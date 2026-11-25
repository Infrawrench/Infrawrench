/** Durations and money, as the CI and Infrastructure pages write them. */

/** `42s`, `3m 7s`, `1h 4m`; empty when there is no duration. */
export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return "";
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60
    ? `${minutes}m ${seconds % 60}s`
    : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** The time between two instants; up to `now` when it has not ended. */
export function durationBetween(
  startedAt: string | null,
  finishedAt: string | null,
  now: number = Date.now(),
): number | null {
  if (startedAt === null) return null;
  const end = finishedAt === null ? now : Date.parse(finishedAt);
  return Math.max(0, end - Date.parse(startedAt));
}

const formatters = new Map<string, Intl.NumberFormat>();

/** `$1,204.50`. An unknown currency code is written after the number. */
export function formatMoney(amount: number, currency: string): string {
  let formatter = formatters.get(currency);
  if (!formatter) {
    try {
      formatter = new Intl.NumberFormat("en", {
        style: "currency",
        currency,
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      });
    } catch {
      return `${amount.toFixed(2)} ${currency}`;
    }
    formatters.set(currency, formatter);
  }
  return formatter.format(amount);
}

/** `+$12.40`, `-$3.00`, `$0.00`: a change, signed. */
export function formatMoneyDelta(amount: number, currency: string): string {
  const rounded = Math.round(amount * 100) / 100;
  if (rounded === 0) return formatMoney(0, currency);
  return `${rounded > 0 ? "+" : "-"}${formatMoney(Math.abs(rounded), currency)}`;
}
