/**
 * Pure roll-ups over Cursor's daily usage rows and usage events: what the
 * member list, the model list and every Metrics tab are built from.
 */
import type { MetricSeries } from "@infrawrench/plugin-base";
import type { CursorDailyUsage, CursorUsageEvent } from "./api.js";
import { eventCents, eventDay, isUsageBased } from "./cost-data.js";

/** A member's activity over the trailing window. */
export interface MemberActivity {
  lastActiveDay: string;
  activeDays: number;
  requests: number;
  usageBasedRequests: number;
  acceptedLines: number;
  tabsAccepted: number;
  mostUsedModel: string;
  clientVersion: string;
}

export function dailyRequests(row: CursorDailyUsage): number {
  return (
    n(row.composerRequests) +
    n(row.chatRequests) +
    n(row.agentRequests) +
    n(row.cmdkUsages) +
    n(row.bugbotUsages)
  );
}

function dayOf(row: CursorDailyUsage): string {
  if (row.day) return row.day;
  if (typeof row.date === "number") return new Date(row.date).toISOString().slice(0, 10);
  return "";
}

/** Group daily usage rows by lower-cased email into per-member activity. */
export function memberActivity(rows: CursorDailyUsage[]): Map<string, MemberActivity> {
  const out = new Map<string, MemberActivity>();
  const latestDay = new Map<string, string>();
  const modelCounts = new Map<string, Map<string, number>>();
  for (const row of rows) {
    const email = (row.email ?? "").toLowerCase();
    const day = dayOf(row);
    if (!email || !day || row.isActive === false) continue;
    let a = out.get(email);
    if (!a) {
      a = {
        lastActiveDay: "",
        activeDays: 0,
        requests: 0,
        usageBasedRequests: 0,
        acceptedLines: 0,
        tabsAccepted: 0,
        mostUsedModel: "",
        clientVersion: "",
      };
      out.set(email, a);
    }
    a.activeDays += 1;
    a.requests += dailyRequests(row);
    a.usageBasedRequests += n(row.usageBasedReqs);
    a.acceptedLines += n(row.acceptedLinesAdded);
    a.tabsAccepted += n(row.totalTabsAccepted);
    if (day > a.lastActiveDay) a.lastActiveDay = day;
    if (row.clientVersion && day >= (latestDay.get(email) ?? "")) {
      a.clientVersion = row.clientVersion;
      latestDay.set(email, day);
    }
    if (row.mostUsedModel) {
      const counts = modelCounts.get(email) ?? new Map<string, number>();
      counts.set(row.mostUsedModel, (counts.get(row.mostUsedModel) ?? 0) + 1);
      modelCounts.set(email, counts);
    }
  }
  for (const [email, counts] of modelCounts) {
    const best = [...counts.entries()].sort((x, y) => y[1] - x[1])[0];
    const a = out.get(email);
    if (a && best) a.mostUsedModel = best[0];
  }
  return out;
}

/** Per-model totals over a set of usage events. */
export interface ModelUsage {
  model: string;
  requests: number;
  usageBasedRequests: number;
  includedRequests: number;
  usageBasedCents: number;
  tokenCostCents: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  maxModeRequests: number;
  users: number;
  lastUsedMs: number;
}

export function modelUsage(events: CursorUsageEvent[]): ModelUsage[] {
  const out = new Map<string, ModelUsage & { userSet: Set<string> }>();
  for (const e of events) {
    const model = e.model?.trim();
    if (!model) continue;
    let m = out.get(model);
    if (!m) {
      m = {
        model,
        requests: 0,
        usageBasedRequests: 0,
        includedRequests: 0,
        usageBasedCents: 0,
        tokenCostCents: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        maxModeRequests: 0,
        users: 0,
        lastUsedMs: 0,
        userSet: new Set(),
      };
      out.set(model, m);
    }
    m.requests += 1;
    if (isUsageBased(e)) {
      m.usageBasedRequests += 1;
      m.usageBasedCents += eventCents(e);
    } else if (/included/i.test(e.kind ?? "")) {
      m.includedRequests += 1;
    }
    m.tokenCostCents += n(e.tokenUsage?.totalCents);
    m.inputTokens += n(e.tokenUsage?.inputTokens);
    m.outputTokens += n(e.tokenUsage?.outputTokens);
    m.cacheReadTokens += n(e.tokenUsage?.cacheReadTokens);
    m.cacheWriteTokens += n(e.tokenUsage?.cacheWriteTokens);
    if (e.maxMode) m.maxModeRequests += 1;
    if (e.userEmail) m.userSet.add(e.userEmail.toLowerCase());
    const ts = Number(e.timestamp);
    if (Number.isFinite(ts) && ts > m.lastUsedMs) m.lastUsedMs = ts;
  }
  return [...out.values()]
    .map(({ userSet, ...rest }) => ({ ...rest, users: userSet.size }))
    .sort((a, b) => b.requests - a.requests);
}

// ---------------------------------------------------------------------------
// Metric series
// ---------------------------------------------------------------------------

function series(label: string, unit: string, byDay: Map<string, number>): MetricSeries {
  return {
    label,
    unit,
    points: [...byDay.entries()]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([day, value]) => ({
        timestamp: Date.parse(`${day}T00:00:00Z`),
        value: Math.round(value * 100) / 100,
      })),
  };
}

function bump(map: Map<string, number>, day: string, value: number): void {
  map.set(day, (map.get(day) ?? 0) + value);
}

/**
 * Daily series from daily-usage rows: active users, requests by feature,
 * included vs usage-based requests, accepted lines and Tab acceptance.
 * `perMember` drops the active-user series, which is meaningless for one person.
 */
export function dailyUsageSeries(
  rows: CursorDailyUsage[],
  opts: { perMember?: boolean } = {},
): MetricSeries[] {
  const active = new Map<string, number>();
  const agent = new Map<string, number>();
  const chat = new Map<string, number>();
  const composer = new Map<string, number>();
  const cmdk = new Map<string, number>();
  const bugbot = new Map<string, number>();
  const included = new Map<string, number>();
  const usageBased = new Map<string, number>();
  const apiKey = new Map<string, number>();
  const linesAccepted = new Map<string, number>();
  const linesSuggested = new Map<string, number>();
  const tabsShown = new Map<string, number>();
  const tabsAccepted = new Map<string, number>();
  for (const row of rows) {
    const day = dayOf(row);
    if (!day) continue;
    if (row.isActive !== false) bump(active, day, 1);
    bump(agent, day, n(row.agentRequests));
    bump(chat, day, n(row.chatRequests));
    bump(composer, day, n(row.composerRequests));
    bump(cmdk, day, n(row.cmdkUsages));
    bump(bugbot, day, n(row.bugbotUsages));
    bump(included, day, n(row.subscriptionIncludedReqs));
    bump(usageBased, day, n(row.usageBasedReqs));
    bump(apiKey, day, n(row.apiKeyReqs));
    bump(linesAccepted, day, n(row.acceptedLinesAdded));
    bump(linesSuggested, day, n(row.totalLinesAdded));
    bump(tabsShown, day, n(row.totalTabsShown));
    bump(tabsAccepted, day, n(row.totalTabsAccepted));
  }
  const tabRate = new Map<string, number>();
  for (const [day, shown] of tabsShown) {
    if (shown > 0) tabRate.set(day, ((tabsAccepted.get(day) ?? 0) / shown) * 100);
  }
  return [
    ...(opts.perMember ? [] : [series("Active users", "users", active)]),
    series("Agent requests", "requests", agent),
    series("Chat requests", "requests", chat),
    series("Composer requests", "requests", composer),
    series("Cmd+K uses", "uses", cmdk),
    series("Bugbot runs", "runs", bugbot),
    series("Included requests", "requests", included),
    series("Usage-based requests", "requests", usageBased),
    series("Own API key requests", "requests", apiKey),
    series("Lines suggested", "lines", linesSuggested),
    series("Lines accepted", "lines", linesAccepted),
    series("Tab suggestions accepted", "suggestions", tabsAccepted),
    series("Tab acceptance rate", "%", tabRate),
  ];
}

/** Daily series from usage events: requests, usage-based spend and tokens. */
export function eventSeries(events: CursorUsageEvent[]): MetricSeries[] {
  const requests = new Map<string, number>();
  const usageRequests = new Map<string, number>();
  const spend = new Map<string, number>();
  const input = new Map<string, number>();
  const output = new Map<string, number>();
  const cacheRead = new Map<string, number>();
  const cacheWrite = new Map<string, number>();
  for (const e of events) {
    const day = eventDay(e);
    if (!day) continue;
    bump(requests, day, 1);
    if (isUsageBased(e)) {
      bump(usageRequests, day, 1);
      bump(spend, day, eventCents(e) / 100);
    }
    bump(input, day, n(e.tokenUsage?.inputTokens));
    bump(output, day, n(e.tokenUsage?.outputTokens));
    bump(cacheRead, day, n(e.tokenUsage?.cacheReadTokens));
    bump(cacheWrite, day, n(e.tokenUsage?.cacheWriteTokens));
  }
  return [
    series("Requests", "requests", requests),
    series("Usage-based requests", "requests", usageRequests),
    series("Usage-based spend", "USD", spend),
    series("Input tokens", "tokens", input),
    series("Output tokens", "tokens", output),
    series("Cache read tokens", "tokens", cacheRead),
    series("Cache write tokens", "tokens", cacheWrite),
  ];
}

/** Build one daily series from analytics rows keyed by a date field. */
export function analyticsSeries<T>(
  rows: T[],
  label: string,
  unit: string,
  dayOfRow: (row: T) => string | undefined,
  valueOf: (row: T) => number,
): MetricSeries {
  const byDay = new Map<string, number>();
  for (const row of rows) {
    const day = dayOfRow(row)?.slice(0, 10);
    if (day) bump(byDay, day, valueOf(row));
  }
  return series(label, unit, byDay);
}

export function n(value: unknown): number {
  const v = Number(value);
  return Number.isFinite(v) ? v : 0;
}
