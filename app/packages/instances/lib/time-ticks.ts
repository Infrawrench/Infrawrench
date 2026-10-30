const DAY = 86400;

/** Labels for a time axis: years, or months when the span is under two years; about six of them. */
export function timeTicks(t0: number, t1: number, locale = "en"): { at: number; label: string }[] {
  const a = new Date(t0 * 1000);
  const years = (t1 - t0) / (365 * DAY);
  const ticks: { at: number; label: string }[] = [];
  if (years >= 2) {
    const step = Math.ceil(years / 6);
    for (let y = a.getUTCFullYear() + 1; ; y += step) {
      const at = Date.UTC(y, 0, 1) / 1000;
      if (at > t1) break;
      ticks.push({ at, label: String(y) });
    }
  } else {
    const months = Math.max(1, Math.ceil((years * 12) / 6));
    const fmt = new Intl.DateTimeFormat(locale, {
      month: "short",
      year: "2-digit",
      timeZone: "UTC",
    });
    for (let i = 1; ; i += months) {
      const at = Date.UTC(a.getUTCFullYear(), a.getUTCMonth() + i, 1) / 1000;
      if (at > t1) break;
      ticks.push({ at, label: fmt.format(new Date(at * 1000)) });
    }
  }
  return ticks;
}
