/** Small formatters every page shares. */

const UNITS = ["B", "KB", "MB", "GB", "TB"] as const;

export function formatBytes(bytes: number): string {
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit++;
  }
  const digits = unit === 0 || value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(digits)} ${UNITS[unit]}`;
}

export const shortOid = (oid: string): string => oid.slice(0, 7);

/** `1 commit`, `2 commits`. */
export const plural = (count: number, one: string, many = `${one}s`): string =>
  `${formatCount(count)} ${count === 1 ? one : many}`;

const countFormat = new Intl.NumberFormat("en");
export const formatCount = (count: number): string => countFormat.format(count);

/** `1.2k` for a star count that has to fit a button. */
export function compactCount(count: number): string {
  if (count < 1000) return String(count);
  if (count < 10_000) return `${(count / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  return `${Math.round(count / 1000)}k`;
}

const MINUTE = 60;
const HOUR = 3600;
const DAY = 86_400;

const relative = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

/** `3 hours ago`, `yesterday`, `last month`; a date once it is over a year old. */
export function relativeTime(iso: string, now: number = Date.now()): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const seconds = Math.round((then - now) / 1000);
  const magnitude = Math.abs(seconds);
  if (magnitude < 45) return "just now";
  if (magnitude < HOUR) return relative.format(Math.round(seconds / MINUTE), "minute");
  if (magnitude < DAY) return relative.format(Math.round(seconds / HOUR), "hour");
  if (magnitude < DAY * 30) return relative.format(Math.round(seconds / DAY), "day");
  if (magnitude < DAY * 365) return relative.format(Math.round(seconds / (DAY * 30)), "month");
  return formatDate(iso);
}

const dateFormat = new Intl.DateTimeFormat("en", {
  year: "numeric",
  month: "short",
  day: "numeric",
});
const dateTimeFormat = new Intl.DateTimeFormat("en", {
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  timeZoneName: "short",
});

export const formatDate = (iso: string): string => dateFormat.format(new Date(iso));
export const formatDateTime = (iso: string): string => dateTimeFormat.format(new Date(iso));

/** The local calendar day of an instant, as `YYYY-MM-DD`, for grouping a history by day. */
export function dayKey(iso: string): string {
  const date = new Date(iso);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

/** Consecutive items with the same key, in order. */
export function groupConsecutive<T>(
  items: ReadonlyArray<T>,
  keyOf: (item: T) => string,
): Array<{ key: string; items: T[] }> {
  const groups: Array<{ key: string; items: T[] }> = [];
  for (const item of items) {
    const key = keyOf(item);
    const last = groups[groups.length - 1];
    if (last && last.key === key) last.items.push(item);
    else groups.push({ key, items: [item] });
  }
  return groups;
}
