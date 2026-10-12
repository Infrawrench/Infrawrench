import { useMemo, useState } from "react";
import { useGT } from "gt-react";
import type { MetricSeries } from "@infrawrench/plugin-base";
import {
  SCORECARD_LIMITS,
  formatServiceCost,
  type Scorecard,
  type ScorecardHistoryPoint,
  type ScorecardResult,
  type ServiceDetailResponse,
  type ServiceMember,
  type ServiceScorecardsResponse,
  type ServiceSummaryResponse,
} from "@infrawrench/client-core";
import { MetricChart } from "../components/charts/MetricChart.js";
import { IssueIndicator } from "../components/IssueIndicator.js";
import { useDataString } from "../i18n/data-strings.js";
import { sloStatusLabel } from "../slos/SlosPanel.js";
import { AddResourcesModal } from "./AddResourcesModal.js";
import {
  ScoreBadge,
  checkStatusClass,
  checkStatusLabel,
  errorMessage,
  levelColor,
  smallButtonClass,
  useTierLabel,
} from "./shared.js";
import type { ServicesClient } from "./types.js";

export interface ServiceResourceRef {
  accountId: string;
  resourceId: string;
  pluginId: string;
  resourceTypeId: string;
}

type Gt = ReturnType<typeof useGT>;

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-border bg-surface-raised px-4 py-3">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-on-surface-faint mb-2">
        {title}
      </h3>
      {children}
    </section>
  );
}

function Faint({ children }: { children: React.ReactNode }) {
  return <p className="text-sm text-on-surface-faint">{children}</p>;
}

function changeKindLabel(kind: "created" | "updated" | "deleted", gt: Gt): string {
  switch (kind) {
    case "created":
      return gt("Created");
    case "updated":
      return gt("Updated");
    case "deleted":
      return gt("Deleted");
  }
}

function severityLabel(severity: string, gt: Gt): string {
  switch (severity) {
    case "critical":
      return gt("Critical");
    case "high":
      return gt("High");
    case "medium":
      return gt("Medium");
    case "low":
      return gt("Low");
    default:
      return severity;
  }
}

function backupKindLabel(kind: string, gt: Gt): string {
  switch (kind) {
    case "unprotected":
      return gt("Not backed up");
    case "rpo-breach":
      return gt("Backup older than policy");
    case "retention-below-policy":
      return gt("Retention below policy");
    case "drill-stale":
      return gt("Restore drill out of date");
    case "drill-failed":
      return gt("Restore drill failed");
    case "drill-never":
      return gt("Never restore-tested");
    default:
      return kind;
  }
}

function feedLabel(feed: "posture" | "orphans" | "backups", gt: Gt): string {
  switch (feed) {
    case "posture":
      return gt("posture findings");
    case "orphans":
      return gt("orphaned resources");
    case "backups":
      return gt("backup coverage");
  }
}

function historySeries(points: readonly ScorecardHistoryPoint[], label: string): MetricSeries[] {
  const scored = points.filter(
    (p): p is ScorecardHistoryPoint & { score: number } => p.score !== null,
  );
  if (scored.length === 0) return [];
  return [
    {
      label,
      unit: "%",
      points: scored.map((p) => ({ timestamp: Date.parse(`${p.day}T00:00:00Z`), value: p.score })),
    },
  ];
}

function ScorecardResultCard({
  result,
  history,
  scorecards,
}: {
  result: ScorecardResult;
  history: readonly ScorecardHistoryPoint[];
  scorecards: readonly Scorecard[] | null;
}) {
  const gt = useGT();
  const series = useMemo(() => historySeries(history, gt("Score")), [history, gt]);
  return (
    <section className="rounded-xl border border-border bg-surface-raised px-4 py-3 space-y-3">
      <div className="flex items-center gap-2 flex-wrap">
        <h4 className="text-sm font-semibold text-on-surface">{result.scorecardName}</h4>
        <ScoreBadge
          score={result.score}
          levelName={result.levelName}
          color={levelColor(scorecards, result.scorecardId, result.level)}
        />
        <span className="ml-auto text-xs text-on-surface-faint">
          {gt("Evaluated {when}", { when: new Date(result.evaluatedAt).toLocaleString() })}
        </span>
      </div>
      <ul className="divide-y divide-border">
        {result.checks.map((check) => (
          <li key={check.checkId} className="py-1.5 flex items-start gap-3 text-sm">
            <span className={`w-12 shrink-0 text-xs font-medium ${checkStatusClass(check.status)}`}>
              {checkStatusLabel(check.status, gt)}
            </span>
            <span className="flex-1 min-w-0">
              <span className="text-on-surface">{check.name}</span>
              {check.detail && (
                <span className="block text-xs text-on-surface-faint">{check.detail}</span>
              )}
            </span>
            <span className="text-xs text-on-surface-faint tabular-nums shrink-0">
              {gt("weight {weight}", { weight: check.weight })}
            </span>
          </li>
        ))}
      </ul>
      {series.length > 0 ? (
        <MetricChart
          node={{
            kind: "metric-chart",
            title: gt("Score history"),
            series,
            timeRangeLabel: gt("Last {days} days, one point per day", {
              days: SCORECARD_LIMITS.historyDays,
            }),
          }}
        />
      ) : (
        <p className="text-xs text-on-surface-faint">{gt("No score history yet.")}</p>
      )}
    </section>
  );
}

function MembersTable({
  members,
  excluded,
  canWrite,
  busy,
  onRemove,
  onRestore,
  onOpenResource,
}: {
  members: ServiceMember[];
  excluded: ServiceMember[];
  canWrite: boolean;
  busy: string | null;
  onRemove: (m: ServiceMember) => void;
  onRestore: (m: ServiceMember) => void;
  onOpenResource?: ((ref: ServiceResourceRef) => void) | undefined;
}) {
  const gt = useGT();
  const dataString = useDataString();
  const nameCell = (m: ServiceMember) =>
    onOpenResource && !m.missing ? (
      <button
        type="button"
        className="text-left text-on-surface hover:underline"
        onClick={() =>
          onOpenResource({
            accountId: m.accountId,
            resourceId: m.resourceId,
            pluginId: m.pluginId,
            resourceTypeId: m.resourceTypeId,
          })
        }
      >
        {m.resourceName}
      </button>
    ) : (
      <span className="text-on-surface">{m.resourceName}</span>
    );
  return (
    <>
      {members.length === 0 ? (
        <Faint>{gt("No members yet. Add resources by hand or with a membership rule.")}</Faint>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-xs text-on-surface-secondary">
              <tr>
                <th scope="col" className="py-1.5 pr-3 text-left font-medium">
                  {gt("Resource")}
                </th>
                <th scope="col" className="py-1.5 pr-3 text-left font-medium">
                  {gt("Provider")}
                </th>
                <th scope="col" className="py-1.5 pr-3 text-left font-medium">
                  {gt("Account")}
                </th>
                <th scope="col" className="py-1.5 pr-3 text-left font-medium">
                  {gt("Source")}
                </th>
                <th scope="col" className="py-1.5 pr-3 text-left font-medium">
                  {gt("Owner")}
                </th>
                {canWrite && (
                  <th scope="col" className="py-1.5 text-left font-medium">
                    <span className="sr-only">{gt("Actions")}</span>
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {members.map((m) => (
                <tr key={m.resourceId} className="border-t border-border hover:bg-surface-sunken">
                  <td className="py-1.5 pr-3">
                    <span className="flex items-center gap-1.5">
                      {m.missing && (
                        <IssueIndicator
                          tone="warning"
                          reason={gt("This resource was deleted upstream")}
                        />
                      )}
                      {nameCell(m)}
                    </span>
                  </td>
                  <td className="py-1.5 pr-3 text-on-surface-secondary">
                    {dataString(m.pluginId)}
                  </td>
                  <td className="py-1.5 pr-3 text-on-surface-secondary">
                    {m.accountName ?? gt("Unknown account")}
                  </td>
                  <td className="py-1.5 pr-3 text-on-surface-secondary">
                    {m.source === "manual"
                      ? gt("Added by hand")
                      : gt("Rule {n}", { n: (m.ruleIndex ?? 0) + 1 })}
                  </td>
                  <td className="py-1.5 pr-3 text-on-surface-secondary">
                    {m.owner?.displayName ?? "-"}
                  </td>
                  {canWrite && (
                    <td className="py-1.5 text-right">
                      <button
                        type="button"
                        className={`${smallButtonClass} text-danger`}
                        disabled={busy === m.resourceId}
                        onClick={() => onRemove(m)}
                        aria-label={
                          m.source === "manual"
                            ? gt("Remove {name}", { name: m.resourceName })
                            : gt("Exclude {name}", { name: m.resourceName })
                        }
                        title={
                          m.source === "rule"
                            ? gt(
                                "A rule matches this resource, so it is excluded rather than removed.",
                              )
                            : undefined
                        }
                      >
                        {m.source === "manual" ? gt("Remove") : gt("Exclude")}
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {excluded.length > 0 && (
        <div className="mt-3">
          <h4 className="text-xs font-semibold text-on-surface-secondary mb-1">{gt("Excluded")}</h4>
          <p className="text-xs text-on-surface-faint mb-1.5">
            {gt("A rule matches these, but they were taken out of the service.")}
          </p>
          <ul className="space-y-1">
            {excluded.map((m) => (
              <li key={m.resourceId} className="flex items-center gap-2 text-sm">
                <span className="flex-1 min-w-0 truncate text-on-surface-secondary">
                  {m.resourceName}
                  <span className="text-xs text-on-surface-faint">
                    {" · "}
                    {dataString(m.pluginId)}
                    {m.accountName ? ` · ${m.accountName}` : ""}
                  </span>
                </span>
                {canWrite && (
                  <button
                    type="button"
                    className={smallButtonClass}
                    disabled={busy === m.resourceId}
                    onClick={() => onRestore(m)}
                    aria-label={gt("Restore {name}", { name: m.resourceName })}
                  >
                    {gt("Restore")}
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}

function SummaryCards({ summary }: { summary: ServiceSummaryResponse }) {
  const gt = useGT();
  const { cost, slos, onCall, runbooks, findings, recentChanges } = summary;
  const service = summary.service;
  const posture = findings.posture.counts;
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
      <Card title={gt("Cost, last {days} days", { days: cost.windowDays })}>
        {!cost.available ? (
          <p className="text-sm text-warning">
            {gt("Unavailable: the cost data could not be read right now.")}
          </p>
        ) : (
          <>
            <p className="text-lg font-semibold text-on-surface tabular-nums">
              {cost.totals.length === 0
                ? gt("No per-resource cost")
                : formatServiceCost(cost.totals)}
            </p>
            <p className="text-xs text-on-surface-faint">
              {gt("{costed} of {members} members have per-resource cost rows", {
                costed: cost.costedMembers,
                members: summary.memberCount,
              })}
            </p>
            {service.monthlyBudget !== null && service.budgetCurrency && (
              <p className="text-xs text-on-surface-secondary mt-1">
                {gt("Monthly budget: {budget}", {
                  budget: formatServiceCost([
                    { currency: service.budgetCurrency, amount: service.monthlyBudget },
                  ]),
                })}
              </p>
            )}
          </>
        )}
      </Card>

      <Card title={gt("On call")}>
        {!onCall ? (
          <Faint>{gt("No on-call schedule linked.")}</Faint>
        ) : (
          <div className="text-sm space-y-0.5">
            <p className="text-on-surface-secondary">
              {onCall.enabled
                ? onCall.scheduleName
                : gt("{name} (disabled)", { name: onCall.scheduleName })}
            </p>
            {onCall.current ? (
              <p className="text-on-surface">
                {gt("{who}, until {when}", {
                  who: onCall.current.name ?? onCall.current.email ?? onCall.current.userId,
                  when: new Date(onCall.current.endsAt).toLocaleString(),
                })}
              </p>
            ) : (
              <p className="text-warning">{gt("Nobody is on call right now.")}</p>
            )}
            {onCall.next && (
              <p className="text-xs text-on-surface-faint">
                {gt("Next: {who}", {
                  who: onCall.next.name ?? onCall.next.email ?? onCall.next.userId,
                })}
              </p>
            )}
          </div>
        )}
      </Card>

      <Card title={gt("SLOs")}>
        {slos.length === 0 ? (
          <Faint>{gt("No SLOs linked.")}</Faint>
        ) : (
          <ul className="space-y-1 text-sm">
            {slos.map((s) => (
              <li key={s.id} className="flex items-center gap-2">
                {(s.status === "exhausted" || s.status === "fast_burn") && (
                  <IssueIndicator tone="danger" reason={sloStatusLabel(s.status, gt)} />
                )}
                {s.status === "slow_burn" && (
                  <IssueIndicator tone="warning" reason={sloStatusLabel(s.status, gt)} />
                )}
                <span className="flex-1 min-w-0 truncate text-on-surface">{s.name}</span>
                <span className="text-xs text-on-surface-secondary tabular-nums">
                  {sloStatusLabel(s.status, gt)}
                  {s.budgetRemaining !== null
                    ? ` · ${gt("{pct} budget left", {
                        pct: `${Number((s.budgetRemaining * 100).toFixed(1))}%`,
                      })}`
                    : ""}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title={gt("Runbooks")}>
        {runbooks.length === 0 ? (
          <Faint>{gt("No runbooks linked.")}</Faint>
        ) : (
          <ul className="space-y-1 text-sm">
            {runbooks.map((r) => (
              <li key={r.id} className="text-on-surface">
                {r.enabled ? r.name : gt("{name} (disabled)", { name: r.name })}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title={gt("Findings")}>
        <div className="space-y-2 text-sm">
          {!findings.unavailable.includes("posture") && (
            <div>
              <p className="text-on-surface">
                {gt("Posture: {critical} critical, {high} high, {medium} medium, {low} low", {
                  critical: posture.critical,
                  high: posture.high,
                  medium: posture.medium,
                  low: posture.low,
                })}
              </p>
              {findings.posture.items.length > 0 && (
                <ul className="mt-1 space-y-0.5">
                  {findings.posture.items.slice(0, 8).map((f) => (
                    <li
                      key={`${f.resourceId}:${f.ruleId}`}
                      className="text-xs text-on-surface-secondary"
                    >
                      <span
                        className={
                          f.severity === "critical"
                            ? "text-danger"
                            : f.severity === "high"
                              ? "text-severe"
                              : "text-on-surface-faint"
                        }
                      >
                        {severityLabel(f.severity, gt)}
                      </span>{" "}
                      {gt("{title} on {resource}", { title: f.title, resource: f.displayName })}
                    </li>
                  ))}
                  {findings.posture.items.length > 8 && (
                    <li className="text-xs text-on-surface-faint">
                      {gt("and {count} more", { count: findings.posture.items.length - 8 })}
                    </li>
                  )}
                </ul>
              )}
            </div>
          )}
          {!findings.unavailable.includes("orphans") && (
            <div>
              <p className="text-on-surface">
                {gt("Orphaned resources: {count}", { count: findings.orphans.length })}
              </p>
              {findings.orphans.length > 0 && (
                <ul className="mt-1 space-y-0.5">
                  {findings.orphans.slice(0, 5).map((o) => (
                    <li key={o.resourceId} className="text-xs text-on-surface-secondary">
                      {gt("{resource}: {reason}", { resource: o.resourceName, reason: o.reason })}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
          {!findings.unavailable.includes("backups") && (
            <div>
              <p className="text-on-surface">
                {gt("Backup and restore-drill issues: {count}", {
                  count: findings.backups.length,
                })}
              </p>
              {findings.backups.length > 0 && (
                <ul className="mt-1 space-y-0.5">
                  {findings.backups.slice(0, 5).map((b) => (
                    <li
                      key={`${b.resourceId}:${b.kind}`}
                      className="text-xs text-on-surface-secondary"
                    >
                      {gt("{resource}: {kind}", {
                        resource: b.resourceName,
                        kind: backupKindLabel(b.kind, gt),
                      })}
                      {b.detail ? ` (${b.detail})` : ""}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
          {findings.unavailable.length > 0 && (
            <p className="text-xs text-warning">
              {gt("Could not load: {feeds}. Those counts are left out, not zero.", {
                feeds: findings.unavailable.map((f) => feedLabel(f, gt)).join(", "),
              })}
            </p>
          )}
        </div>
      </Card>

      <Card title={gt("Recent changes")}>
        {recentChanges.length === 0 ? (
          <Faint>{gt("No recorded changes to members.")}</Faint>
        ) : (
          <ul className="space-y-1 text-sm">
            {recentChanges.slice(0, 10).map((c) => (
              <li key={c.id} className="flex items-baseline gap-2">
                <span className="text-xs text-on-surface-faint tabular-nums shrink-0">
                  {new Date(c.at).toLocaleString()}
                </span>
                <span className="min-w-0 text-on-surface-secondary">
                  {gt("{kind}: {resource}", {
                    kind: changeKindLabel(c.changeKind, gt),
                    resource: c.resourceName,
                  })}
                  {c.fields.length > 0 && (
                    <span className="text-xs text-on-surface-faint">
                      {" "}
                      ({c.fields.slice(0, 4).join(", ")}
                      {c.fields.length > 4 ? ", …" : ""})
                    </span>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

export interface ServiceDetailViewProps {
  client: ServicesClient;
  detail: ServiceDetailResponse;
  summary: ServiceSummaryResponse | null;
  summaryError: string | null;
  scorecardResults: ServiceScorecardsResponse | null;
  scorecards: Scorecard[] | null;
  canWrite: boolean;
  onBack: () => void;
  onEdit: () => void;
  onDeleted: () => void;
  onMembershipChanged: (detail: ServiceDetailResponse) => void;
  onOpenResource?: ((ref: ServiceResourceRef) => void) | undefined;
}

/** One service: header, summary cards, members and scorecard results. */
export function ServiceDetailView({
  client,
  detail,
  summary,
  summaryError,
  scorecardResults,
  scorecards,
  canWrite,
  onBack,
  onEdit,
  onDeleted,
  onMembershipChanged,
  onOpenResource,
}: ServiceDetailViewProps) {
  const gt = useGT();
  const tierLabel = useTierLabel();
  const { service, members, excluded } = detail;
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const memberIds = useMemo(() => new Set(members.map((m) => m.resourceId)), [members]);

  const remove = async () => {
    if (!window.confirm(gt('Delete service "{name}"?', { name: service.name }))) return;
    try {
      await client.deleteService?.(service.id);
      onDeleted();
    } catch (e) {
      setError(errorMessage(e, gt("Failed to delete the service")));
    }
  };

  const mutateMember = async (
    m: ServiceMember,
    run: () => Promise<ServiceDetailResponse | null> | undefined,
    fallback: string,
  ) => {
    setBusy(m.resourceId);
    setError(null);
    try {
      const next = await run();
      if (next) onMembershipChanged(next);
    } catch (e) {
      setError(errorMessage(e, fallback));
    } finally {
      setBusy(null);
    }
  };

  const ownerNames = service.owners.map((o) => o.name ?? o.email ?? o.userId);

  return (
    <div className="space-y-5">
      <div>
        <button
          type="button"
          onClick={onBack}
          className="text-xs text-on-surface-secondary hover:text-on-surface"
        >
          {gt("← All services")}
        </button>
        <div className="mt-1 flex items-start gap-3">
          <div className="flex-1 min-w-0">
            <h2 className="text-base font-semibold text-on-surface">{service.name}</h2>
            <p className="text-xs text-on-surface-faint">
              {tierLabel(service.tier)} · <span className="font-mono">{service.slug}</span>
              {service.ownerTeam ? ` · ${gt("Team {team}", { team: service.ownerTeam })}` : ""}
            </p>
            {ownerNames.length > 0 && (
              <p className="text-xs text-on-surface-secondary">
                {gt("Owners: {names}", { names: ownerNames.join(", ") })}
              </p>
            )}
            {service.description && (
              <p className="mt-1 text-sm text-on-surface-secondary">{service.description}</p>
            )}
            {service.links.length > 0 && (
              <ul className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-xs">
                {service.links.map((l) => (
                  <li key={`${l.label}:${l.url}`}>
                    <a
                      href={l.url}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="text-info hover:underline"
                    >
                      {l.label}
                    </a>
                  </li>
                ))}
              </ul>
            )}
          </div>
          {canWrite && (
            <div className="flex items-center gap-1.5 shrink-0">
              <button type="button" onClick={onEdit} className={smallButtonClass}>
                {gt("Edit")}
              </button>
              <button
                type="button"
                onClick={() => void remove()}
                className={`${smallButtonClass} text-danger`}
              >
                {gt("Delete")}
              </button>
            </div>
          )}
        </div>
      </div>

      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}

      {summary ? (
        <SummaryCards summary={summary} />
      ) : summaryError ? (
        <p className="text-sm text-warning">
          {gt("The summary could not be loaded: {error}", { error: summaryError })}
        </p>
      ) : (
        <p role="status" className="text-sm text-on-surface-faint">
          {gt("Loading summary…")}
        </p>
      )}

      <section>
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-sm font-semibold text-on-surface">
            {gt("Members ({count})", { count: members.length })}
          </h3>
          {canWrite && client.addMembers && (
            <button type="button" className={smallButtonClass} onClick={() => setAdding(true)}>
              {gt("Add resources")}
            </button>
          )}
        </div>
        <MembersTable
          members={members}
          excluded={excluded}
          canWrite={canWrite}
          busy={busy}
          onOpenResource={onOpenResource}
          onRemove={(m) =>
            void mutateMember(
              m,
              () => client.removeMember?.(service.id, m.resourceId),
              gt("Failed to remove the resource"),
            )
          }
          onRestore={(m) =>
            void mutateMember(
              m,
              () => client.restoreMember?.(service.id, m.resourceId),
              gt("Failed to restore the resource"),
            )
          }
        />
      </section>

      <section className="space-y-3">
        <h3 className="text-sm font-semibold text-on-surface">{gt("Scorecards")}</h3>
        {scorecardResults === null ? (
          <p role="status" className="text-sm text-on-surface-faint">
            {gt("Loading scorecards…")}
          </p>
        ) : scorecardResults.results.length === 0 ? (
          <Faint>{gt("No scorecard applies to this service yet.")}</Faint>
        ) : (
          scorecardResults.results.map((r) => (
            <ScorecardResultCard
              key={r.scorecardId}
              result={r}
              history={scorecardResults.history[r.scorecardId] ?? []}
              scorecards={scorecards}
            />
          ))
        )}
      </section>

      {adding && client.addMembers && (
        <AddResourcesModal
          client={client}
          memberIds={memberIds}
          onClose={() => setAdding(false)}
          onAdd={async (resourceIds) => {
            const next = await client.addMembers!(service.id, resourceIds);
            if (next) onMembershipChanged(next);
          }}
        />
      )}
    </div>
  );
}
