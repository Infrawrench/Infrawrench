/**
 * AWS public health status feed
 * (https://health.aws.amazon.com/public/currentevents — verified 2026-08;
 * the legacy status.aws.amazon.com/data.json redirects here).
 *
 * Custom JSON: a bare array of event objects, empty when everything is
 * healthy. The wire body is UTF-16 BE with a BOM — the host's fetch helper
 * BOM-sniffs before decoding, so this parser sees a normal string. Verified
 * fields: `date` (unix-epoch string), `arn`, `status` ("0" observed on
 * resolved events), `service` ("directconnect-ap-south-1" — service slug +
 * region), `service_name` ("AWS Direct Connect"), `summary`
 * ("[RESOLVED] Elevated Packet Loss"), `event_log[{summary, message}]`.
 */
import type { StatusFeedDeclaration, StatusIncident } from "@infrawrench/plugin-base";
import { stripStatusHtml } from "@infrawrench/plugin-base";

export const statusFeed: StatusFeedDeclaration = {
  url: "https://health.aws.amazon.com/public/currentevents",
  format: "custom-json",
  statusPageUrl: "https://health.aws.amazon.com/health/status",
};

interface AwsEventJson {
  date?: string;
  arn?: string;
  status?: string;
  service?: string;
  service_name?: string;
  region_name?: string;
  summary?: string;
  event_log?: Array<{ summary?: string; message?: string; timestamp?: string }>;
}

/** "directconnect-ap-south-1" → "ap-south-1"; "route53" → null (global). */
const REGION_SUFFIX = /-((?:us|eu|ap|sa|ca|me|af|il|mx)(?:-[a-z]+)+-\d+)$/;

export function parseStatusFeed(body: string): StatusIncident[] {
  const parsed = JSON.parse(body) as AwsEventJson[];
  if (!Array.isArray(parsed)) {
    throw new Error("AWS health feed: expected a JSON array of events");
  }
  const out: StatusIncident[] = [];
  for (const raw of parsed) {
    if (!raw) continue;
    const externalId = raw.arn ?? (raw.service && raw.date ? `${raw.service}_${raw.date}` : null);
    if (!externalId) continue;
    const summary = raw.summary ?? "AWS service event";
    // The feed keeps recently-resolved events around, marked in the summary
    // (and with status "0"). Skip them — the host closes cached rows that
    // stop appearing, and an explicitly-resolved row shouldn't reopen.
    if (/^\s*\[RESOLVED\]/i.test(summary) || raw.status === "0") continue;
    const regionMatch = raw.service ? raw.service.match(REGION_SUFFIX) : null;
    const region = regionMatch?.[1] ?? null;
    const startedMs = raw.date ? Number(raw.date) * 1000 : NaN;
    // event_log order is not guaranteed — pick the newest by timestamp.
    // Init with undefined so an all-invalid log never emits a bogus update.
    const logs = raw.event_log ?? [];
    const latestLog = logs.reduce<(typeof logs)[number] | undefined>((best, entry) => {
      const entryMs = entry?.timestamp ? Date.parse(entry.timestamp) : NaN;
      if (Number.isNaN(entryMs)) return best;
      const bestMs = best?.timestamp ? Date.parse(best.timestamp) : NaN;
      if (Number.isNaN(bestMs) || entryMs >= bestMs) return entry;
      return best;
    }, undefined);
    const lastUpdateMs = latestLog?.timestamp ? Date.parse(latestLog.timestamp) : NaN;
    out.push({
      externalId,
      title: `${raw.service_name ?? "AWS"}: ${stripStatusHtml(summary).slice(0, 300)}`,
      state: "identified",
      // The public feed doesn't grade severity; AWS only publishes events
      // that are operational issues, so treat them all as major.
      impact: "major",
      url: statusFeed.statusPageUrl ?? statusFeed.url,
      startedAt: Number.isFinite(startedMs)
        ? new Date(startedMs).toISOString()
        : new Date(0).toISOString(),
      ...(latestLog?.message
        ? { lastUpdateText: stripStatusHtml(latestLog.message).slice(0, 500) }
        : {}),
      ...(Number.isFinite(lastUpdateMs)
        ? { lastUpdateAt: new Date(lastUpdateMs).toISOString() }
        : {}),
      regions: region ? [region] : [],
      services: raw.service_name ? [raw.service_name] : [],
      // Events on global services (IAM, Route 53, CloudFront) name no
      // region; treat those as provider-wide.
      ...(region ? {} : { providerWide: true }),
    });
  }
  return out;
}
