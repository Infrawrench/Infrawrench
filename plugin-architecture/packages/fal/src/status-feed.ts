/**
 * fal public status feed (Instatus, https://status.fal.ai; verified 2026-10).
 * `/summary.json` carries `activeIncidents` and `activeMaintenances` only
 * while something is open (the keys are absent when all is well). Instatus
 * summaries name no components, so every entry is provider-wide.
 */
import type {
  StatusFeedDeclaration,
  StatusIncident,
  StatusIncidentImpact,
  StatusIncidentState,
} from "@infrawrench/plugin-base";

const STATUS_PAGE = "https://status.fal.ai";

export const statusFeed: StatusFeedDeclaration = {
  url: `${STATUS_PAGE}/summary.json`,
  format: "custom-json",
  statusPageUrl: STATUS_PAGE,
};

interface InstatusEntry {
  id?: string;
  name?: string;
  started?: string;
  start?: string;
  status?: string;
  impact?: string;
  url?: string;
  updatedAt?: string;
}

function state(status: string): StatusIncidentState {
  switch (status.toUpperCase()) {
    case "IDENTIFIED":
      return "identified";
    case "MONITORING":
      return "monitoring";
    case "RESOLVED":
    case "COMPLETED":
      return "resolved";
    default:
      return "investigating";
  }
}

function impact(value: string): StatusIncidentImpact {
  switch (value.toUpperCase()) {
    case "MAJOROUTAGE":
      return "critical";
    case "PARTIALOUTAGE":
      return "major";
    case "UNDERMAINTENANCE":
      return "maintenance";
    default:
      return "minor";
  }
}

export function parseStatusFeed(body: string): StatusIncident[] {
  const doc = JSON.parse(body) as {
    page?: unknown;
    activeIncidents?: InstatusEntry[];
    activeMaintenances?: InstatusEntry[];
  };
  if (!doc || typeof doc !== "object" || !("page" in doc)) {
    throw new Error("fal status feed: not an Instatus summary");
  }
  const out: StatusIncident[] = [];
  const push = (e: InstatusEntry, maintenance: boolean) => {
    if (!e.id) return;
    const st = state(String(e.status ?? ""));
    if (st === "resolved") return;
    const started = Date.parse(String(e.started ?? e.start ?? ""));
    out.push({
      externalId: String(e.id),
      title: String(e.name ?? "fal incident"),
      state: st,
      impact: maintenance ? "maintenance" : impact(String(e.impact ?? "")),
      url: e.url || `${STATUS_PAGE}/incident/${encodeURIComponent(String(e.id))}`,
      startedAt: Number.isFinite(started)
        ? new Date(started).toISOString()
        : new Date(0).toISOString(),
      ...(e.updatedAt ? { lastUpdateAt: e.updatedAt } : {}),
      regions: [],
      services: [],
      providerWide: true,
    });
  };
  for (const e of doc.activeIncidents ?? []) push(e, false);
  for (const e of doc.activeMaintenances ?? []) {
    if (String(e.status ?? "").toUpperCase() === "NOTSTARTEDYET") continue;
    push(e, true);
  }
  return out;
}
