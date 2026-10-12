import {
  INCIDENT_SEVERITIES,
  formatMonthlyEstimate,
  incidentSeverityRank,
  type Incident,
  type ResourceSpend,
} from "@infrawrench/client-core";

export function formatSpend(spend: readonly ResourceSpend[]): string {
  if (spend.length === 0) return "No cost data";
  return spend
    .map((s) => formatMonthlyEstimate(Math.round(s.amount * 100) / 100, s.currency))
    .join(" + ");
}

/** Open first, then mitigated; worst severity first; newest first. */
export function sortIncidents(list: readonly Incident[]): Incident[] {
  const statusRank = (i: Incident) => (i.status === "open" ? 0 : i.status === "mitigated" ? 1 : 2);
  return [...list].sort(
    (a, b) =>
      statusRank(a) - statusRank(b) ||
      incidentSeverityRank(a.severity) - incidentSeverityRank(b.severity) ||
      b.startedAt.localeCompare(a.startedAt),
  );
}

export const SEVERITY_OPTIONS = INCIDENT_SEVERITIES.map((s) => ({
  value: s.id,
  title: `${s.label}: ${s.description}`,
}));

/** "until 18:00" / "until Tue 09:00": a handoff time in the viewer's zone. */
export function formatHandoff(iso: string, now = new Date()): string {
  const at = new Date(iso);
  const sameDay = at.toDateString() === now.toDateString();
  const time = at.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  return sameDay
    ? `until ${time}`
    : `until ${at.toLocaleDateString(undefined, { weekday: "short" })} ${time}`;
}
