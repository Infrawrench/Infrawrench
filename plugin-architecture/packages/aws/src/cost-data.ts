/**
 * Actual-spend collection via Cost Explorer `GetCostAndUsage`.
 *
 * Cost Explorer is a global service served from us-east-1 only, and AWS
 * charges $0.01 per paginated request — the host's collection cadence
 * (once daily + a chunked one-time backfill) keeps that bounded. Requests
 * are grouped by SERVICE + REGION; per-resource granularity is deliberately
 * not requested (CE only retains it for 14 days and it explodes row counts).
 *
 * Requires the `ce:GetCostAndUsage` IAM action, which is NOT part of typical
 * read-only infra policies — surfaced in the plugin docs.
 */

import type { CostFetchRange, CostRow } from "@infrawrench/plugin-base";
import type { AwsCredentials } from "./auth.js";
import { fetchSigned } from "./signed-request.js";

const CE_URL = "https://ce.us-east-1.amazonaws.com/";

interface CeGroup {
  Keys?: string[];
  Metrics?: Record<string, { Amount?: string; Unit?: string }>;
}

interface CeResultByTime {
  TimePeriod?: { Start?: string };
  Groups?: CeGroup[];
}

interface CeResponse {
  ResultsByTime?: CeResultByTime[];
  NextPageToken?: string;
}

/** CE's pseudo-regions for global/unattributed spend map to "no region". */
function normalizeRegion(raw: string): string {
  if (!raw || raw === "NoRegion" || raw === "global") return "";
  return raw;
}

export async function fetchAwsCostData(
  creds: AwsCredentials,
  range: CostFetchRange,
): Promise<CostRow[]> {
  // TimePeriod.End is exclusive; the host's range is inclusive.
  const endExclusive = new Date(`${range.toDate}T00:00:00.000Z`);
  endExclusive.setUTCDate(endExclusive.getUTCDate() + 1);

  const rows: CostRow[] = [];
  let nextPageToken: string | undefined;

  do {
    const body = JSON.stringify({
      TimePeriod: { Start: range.fromDate, End: endExclusive.toISOString().slice(0, 10) },
      Granularity: "DAILY",
      Metrics: ["UnblendedCost"],
      GroupBy: [
        { Type: "DIMENSION", Key: "SERVICE" },
        { Type: "DIMENSION", Key: "REGION" },
      ],
      ...(nextPageToken ? { NextPageToken: nextPageToken } : {}),
    });

    const res = await fetchSigned({
      method: "POST",
      url: CE_URL,
      headers: {
        "content-type": "application/x-amz-json-1.1",
        "x-amz-target": "AWSInsightsIndexService.GetCostAndUsage",
      },
      body,
      service: "ce",
      // Cost Explorer only exists in us-east-1 — sign for that region
      // regardless of where the account's resources live.
      credentials: { ...creds, region: "us-east-1" },
    });
    const data = (await res.json()) as CeResponse;

    for (const result of data.ResultsByTime ?? []) {
      const date = result.TimePeriod?.Start;
      if (!date) continue;
      for (const group of result.Groups ?? []) {
        const amount = Number(group.Metrics?.["UnblendedCost"]?.Amount ?? "0");
        if (amount === 0) continue;
        rows.push({
          date,
          service: group.Keys?.[0] ?? "",
          region: normalizeRegion(group.Keys?.[1] ?? ""),
          currency: group.Metrics?.["UnblendedCost"]?.Unit ?? "USD",
          amount,
        });
      }
    }
    nextPageToken = data.NextPageToken;
  } while (nextPageToken);

  return rows;
}
