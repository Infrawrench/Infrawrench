/**
 * Parsing for Fireworks' two plain-data observability feeds: the Prometheus
 * exposition served for dedicated deployments, and the account audit log.
 */

/** One sample from a Prometheus text exposition. */
export interface PromSample {
  name: string;
  labels: Record<string, string>;
  value: number;
}

/**
 * Parse the Prometheus text format: `name{a="b",c="d"} value [timestamp]`.
 * Comment and blank lines are skipped, as are samples whose value is not a
 * finite number (`NaN`, `+Inf` on a gauge).
 */
export function parsePromText(text: string): PromSample[] {
  const samples: PromSample[] = [];
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const brace = line.indexOf("{");
    const space = line.indexOf(" ");
    let name: string;
    let labels: Record<string, string> = {};
    let rest: string;
    if (brace !== -1 && (space === -1 || brace < space)) {
      const close = line.lastIndexOf("}");
      if (close === -1) continue;
      name = line.slice(0, brace);
      labels = parseLabels(line.slice(brace + 1, close));
      rest = line.slice(close + 1).trim();
    } else {
      if (space === -1) continue;
      name = line.slice(0, space);
      rest = line.slice(space + 1).trim();
    }
    const value = Number(rest.split(/\s+/)[0]);
    if (!Number.isFinite(value)) continue;
    samples.push({ name, labels, value });
  }
  return samples;
}

function parseLabels(body: string): Record<string, string> {
  const labels: Record<string, string> = {};
  const pattern = /([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*"((?:[^"\\]|\\.)*)"/g;
  for (const match of body.matchAll(pattern)) {
    const key = match[1];
    const raw = match[2];
    if (key === undefined || raw === undefined) continue;
    labels[key] = raw.replace(/\\n/g, "\n").replace(/\\(["\\])/g, "$1");
  }
  return labels;
}

/** Sum of every sample of `name` (across labels other than the filter). */
export function sumSamples(samples: PromSample[], name: string): number | undefined {
  let total: number | undefined;
  for (const s of samples) {
    if (s.name === name) total = (total ?? 0) + s.value;
  }
  return total;
}

/**
 * `histogram_quantile` over cumulative `le` buckets summed across series,
 * with Prometheus' linear interpolation inside the bucket. Returns undefined
 * when the histogram is empty (no traffic in the window).
 */
export function histogramQuantile(
  samples: PromSample[],
  name: string,
  q: number,
): number | undefined {
  const byLe = new Map<number, number>();
  for (const s of samples) {
    if (s.name !== name) continue;
    const le = s.labels["le"];
    if (le === undefined) continue;
    const bound = le === "+Inf" ? Infinity : Number(le);
    if (Number.isNaN(bound)) continue;
    byLe.set(bound, (byLe.get(bound) ?? 0) + s.value);
  }
  const buckets = [...byLe.entries()].sort((a, b) => a[0] - b[0]);
  const total = buckets[buckets.length - 1]?.[1] ?? 0;
  if (buckets.length < 2 || !(total > 0)) return undefined;
  const rank = q * total;
  let prevBound = 0;
  let prevCount = 0;
  for (const [bound, count] of buckets) {
    if (count >= rank) {
      // The +Inf bucket has no upper edge: report the highest finite bound.
      if (bound === Infinity) return prevBound;
      if (count === prevCount) return bound;
      return prevBound + (bound - prevBound) * ((rank - prevCount) / (count - prevCount));
    }
    prevBound = bound;
    prevCount = count;
  }
  return prevBound;
}

/** `gatewayAuditLogEntry`, from `GET /v1/accounts/{id}/auditLogs`. */
export interface AuditLogEntry {
  id?: string;
  method?: string;
  principal?: string;
  status?: { code?: string; message?: string } | null;
  timestamp?: string;
  message?: string;
  resource?: string;
  isAdminAction?: boolean;
  userAgent?: string;
  clientIp?: string;
  apiKeyId?: string;
}

/** One audit entry as a log line: time, outcome, who, what, on which resource. */
export function formatAuditLogEntry(entry: AuditLogEntry): string {
  const code = entry.status?.code || "OK";
  const who = entry.principal || (entry.apiKeyId ? `api-key:${entry.apiKeyId}` : "");
  const head = [
    entry.timestamp ?? "",
    code,
    who,
    lastPart(entry.method ?? ""),
    entry.resource ?? "",
    entry.message ?? "",
  ]
    .filter(Boolean)
    .join(" ");
  const extra: string[] = [];
  if (code !== "OK" && entry.status?.message) extra.push(entry.status.message);
  if (entry.clientIp) extra.push(`ip=${entry.clientIp}`);
  if (entry.userAgent) extra.push(`ua=${entry.userAgent}`);
  return extra.length ? `${head} (${extra.join(", ")})` : head;
}

/** `/gateway.Gateway/CreateDeployment` -> `CreateDeployment`. */
function lastPart(method: string): string {
  return method.slice(method.lastIndexOf("/") + 1);
}
