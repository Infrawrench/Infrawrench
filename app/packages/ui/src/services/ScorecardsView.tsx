import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { useGT } from "gt-react";
import {
  SCORECARD_CHECK_TYPES,
  SERVICE_TIERS,
  scorecardAppliesTo,
  type Scorecard,
  type ScorecardOverviewResponse,
  type ScorecardResult,
  type ServiceTier,
} from "@infrawrench/client-core";
import { useDataString } from "../i18n/data-strings.js";
import { ScorecardEditorModal } from "./ScorecardEditorModal.js";
import { OrgScorecardHeader, type OrgScorecardPillarLinks } from "./OrgScorecardHeader.js";
import {
  ScoreBadge,
  errorMessage,
  inputClass,
  labelClass,
  primaryButtonClass,
  smallButtonClass,
  useTierLabel,
} from "./shared.js";
import type { ServicesClient } from "./types.js";

export interface ScorecardsViewProps {
  client: ServicesClient;
  onOpenService: (serviceId: string) => void;
  /**
   * Where the org grade's pillar cards lead. The service standards pillar
   * needs no entry: it reads the matrix on this same page, and scrolls to it.
   */
  orgScorecardLinks?: OrgScorecardPillarLinks | undefined;
}

/** Sentinel for the "no level reached" filter option. */
const NO_LEVEL = "__none__";

function resultKey(serviceId: string, scorecardId: string): string {
  return `${serviceId}\u0000${scorecardId}`;
}

/**
 * The scorecard matrix (services down, scorecards across) with its filters,
 * and the scorecards themselves: create, edit, re-evaluate and delete.
 */
export function ScorecardsView({ client, onOpenService, orgScorecardLinks }: ScorecardsViewProps) {
  const gt = useGT();
  const dataString = useDataString();
  const tierLabel = useTierLabel();
  const ids = {
    scorecard: useId(),
    tier: useId(),
    level: useId(),
    team: useId(),
    failing: useId(),
  };
  const [data, setData] = useState<ScorecardOverviewResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [gradeKey, setGradeKey] = useState(0);
  const matrixRef = useRef<HTMLElement | null>(null);
  const pillarLinks = useMemo<OrgScorecardPillarLinks>(
    () => ({
      ...orgScorecardLinks,
      services: () => matrixRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }),
    }),
    [orgScorecardLinks],
  );
  const [busy, setBusy] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ existing: Scorecard | null } | null>(null);
  const [scorecardFilter, setScorecardFilter] = useState("");
  const [tierFilter, setTierFilter] = useState("");
  const [levelFilter, setLevelFilter] = useState("");
  const [teamFilter, setTeamFilter] = useState("");
  const [failingFilter, setFailingFilter] = useState("");
  const canWrite = Boolean(
    client.createScorecard && client.updateScorecard && client.deleteScorecard,
  );

  const reload = useCallback(() => {
    setError(null);
    client
      .getScorecardOverview()
      .then(setData)
      .catch((e) => setError(errorMessage(e, gt("Failed to load scorecards"))));
  }, [client, gt]);

  useEffect(() => {
    reload();
  }, [reload]);

  const results = useMemo(() => {
    const map = new Map<string, ScorecardResult>();
    for (const r of data?.results ?? []) map.set(resultKey(r.serviceId, r.scorecardId), r);
    return map;
  }, [data]);

  const columns = useMemo(
    () => (data?.scorecards ?? []).filter((s) => !scorecardFilter || s.id === scorecardFilter),
    [data, scorecardFilter],
  );

  const levelOptions = useMemo(() => {
    const seen = new Map<string, string>();
    for (const card of columns) for (const l of card.levels) seen.set(l.key, l.name);
    return [...seen.entries()].map(([key, name]) => ({ key, name }));
  }, [columns]);

  const teams = useMemo(
    () =>
      [
        ...new Set((data?.services ?? []).map((s) => s.ownerTeam).filter((t): t is string => !!t)),
      ].sort((a, b) => a.localeCompare(b)),
    [data],
  );

  const rows = useMemo(() => {
    return (data?.services ?? []).filter((service) => {
      if (tierFilter === "none" && service.tier !== null) return false;
      if (tierFilter && tierFilter !== "none" && String(service.tier) !== tierFilter) return false;
      if (teamFilter && service.ownerTeam !== teamFilter) return false;
      const cells = columns
        .map((c) => results.get(resultKey(service.id, c.id)))
        .filter((r): r is ScorecardResult => !!r);
      if (levelFilter) {
        const match = cells.some((r) =>
          levelFilter === NO_LEVEL ? r.level === null : r.level === levelFilter,
        );
        if (!match) return false;
      }
      if (failingFilter) {
        const failing = cells.some((r) =>
          r.checks.some(
            (c) => c.type === failingFilter && (c.status === "fail" || c.status === "error"),
          ),
        );
        if (!failing) return false;
      }
      return true;
    });
  }, [data, columns, results, tierFilter, teamFilter, levelFilter, failingFilter]);

  const evaluate = async (card: Scorecard) => {
    if (!client.evaluateScorecard) return;
    setBusy(card.id);
    setError(null);
    try {
      const next = await client.evaluateScorecard(card.id);
      if (next) setData(next);
      else reload();
      // The service standards pillar reads these results.
      setGradeKey((k) => k + 1);
    } catch (e) {
      setError(errorMessage(e, gt("Failed to evaluate the scorecard")));
    } finally {
      setBusy(null);
    }
  };

  const remove = async (card: Scorecard) => {
    if (!client.deleteScorecard) return;
    if (!window.confirm(gt('Delete scorecard "{name}"?', { name: card.name }))) return;
    setBusy(card.id);
    setError(null);
    try {
      await client.deleteScorecard(card.id);
      if (scorecardFilter === card.id) setScorecardFilter("");
      reload();
    } catch (e) {
      setError(errorMessage(e, gt("Failed to delete the scorecard")));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-6">
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}{" "}
          <button type="button" onClick={reload} className="underline">
            {gt("Retry")}
          </button>
        </p>
      )}

      <OrgScorecardHeader client={client} pillarLinks={pillarLinks} reloadKey={gradeKey} />

      <section ref={matrixRef}>
        <h2 className="text-base font-semibold text-on-surface">{gt("Scorecard overview")}</h2>
        <p className="text-xs text-on-surface-faint mb-3">
          {gt(
            "Every service against every scorecard that applies to it. Open a service to see which checks it fails and why.",
          )}
        </p>

        <div className="grid grid-cols-2 md:grid-cols-5 gap-2 mb-3">
          <div>
            <label className={labelClass} htmlFor={ids.scorecard}>
              {gt("Scorecard")}
            </label>
            <select
              id={ids.scorecard}
              className={inputClass}
              value={scorecardFilter}
              onChange={(e) => {
                setScorecardFilter(e.target.value);
                setLevelFilter("");
              }}
            >
              <option value="">{gt("All scorecards")}</option>
              {(data?.scorecards ?? []).map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className={labelClass} htmlFor={ids.tier}>
              {gt("Tier")}
            </label>
            <select
              id={ids.tier}
              className={inputClass}
              value={tierFilter}
              onChange={(e) => setTierFilter(e.target.value)}
            >
              <option value="">{gt("Any tier")}</option>
              {SERVICE_TIERS.map((t) => (
                <option key={t} value={String(t)}>
                  {tierLabel(t)}
                </option>
              ))}
              <option value="none">{gt("Untiered")}</option>
            </select>
          </div>
          <div>
            <label className={labelClass} htmlFor={ids.level}>
              {gt("Level")}
            </label>
            <select
              id={ids.level}
              className={inputClass}
              value={levelFilter}
              onChange={(e) => setLevelFilter(e.target.value)}
            >
              <option value="">{gt("Any level")}</option>
              {levelOptions.map((l) => (
                <option key={l.key} value={l.key}>
                  {l.name}
                </option>
              ))}
              <option value={NO_LEVEL}>{gt("No level reached")}</option>
            </select>
          </div>
          <div>
            <label className={labelClass} htmlFor={ids.team}>
              {gt("Owning team")}
            </label>
            <select
              id={ids.team}
              className={inputClass}
              value={teamFilter}
              onChange={(e) => setTeamFilter(e.target.value)}
            >
              <option value="">{gt("Any team")}</option>
              {teams.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className={labelClass} htmlFor={ids.failing}>
              {gt("Failing check")}
            </label>
            <select
              id={ids.failing}
              className={inputClass}
              value={failingFilter}
              onChange={(e) => setFailingFilter(e.target.value)}
            >
              <option value="">{gt("Any")}</option>
              {SCORECARD_CHECK_TYPES.map((d) => (
                <option key={d.type} value={d.type}>
                  {dataString(d.label)}
                </option>
              ))}
            </select>
          </div>
        </div>

        {data === null && !error && (
          <p role="status" className="text-sm text-on-surface-faint">
            {gt("Loading scorecards…")}
          </p>
        )}
        {data !== null && data.services.length === 0 && (
          <p className="text-sm text-on-surface-faint">
            {gt("No services yet. Create a service to see how it scores.")}
          </p>
        )}
        {data !== null && data.services.length > 0 && columns.length === 0 && (
          <p className="text-sm text-on-surface-faint">{gt("No scorecards yet.")}</p>
        )}
        {data !== null && data.services.length > 0 && columns.length > 0 && (
          <div className="overflow-x-auto rounded-xl border border-border">
            <table className="w-full text-sm">
              <caption className="sr-only">{gt("Scores by service and scorecard")}</caption>
              <thead className="bg-surface-raised text-xs text-on-surface-secondary">
                <tr>
                  <th scope="col" className="px-3 py-2 text-left font-medium">
                    {gt("Service")}
                  </th>
                  {columns.map((c) => (
                    <th key={c.id} scope="col" className="px-3 py-2 text-left font-medium">
                      {c.name}
                      {!c.enabled && (
                        <span className="ml-1 text-on-surface-faint">{gt("(disabled)")}</span>
                      )}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={columns.length + 1} className="px-3 py-3 text-on-surface-faint">
                      {gt("No service matches these filters.")}
                    </td>
                  </tr>
                )}
                {rows.map((service) => (
                  <tr key={service.id} className="border-t border-border hover:bg-surface-sunken">
                    <td className="px-3 py-2">
                      <button
                        type="button"
                        onClick={() => onOpenService(service.id)}
                        className="text-left text-on-surface hover:underline"
                      >
                        {service.name}
                      </button>
                      <div className="text-[11px] text-on-surface-faint">
                        {tierLabel(service.tier)}
                        {service.ownerTeam ? ` · ${service.ownerTeam}` : ""}
                      </div>
                    </td>
                    {columns.map((c) => {
                      const r = results.get(resultKey(service.id, c.id));
                      const color = r?.level
                        ? (c.levels.find((l) => l.key === r.level)?.color ?? null)
                        : null;
                      return (
                        <td key={c.id} className="px-3 py-2">
                          {r ? (
                            <button
                              type="button"
                              onClick={() => onOpenService(service.id)}
                              aria-label={gt("Open {service} ({scorecard})", {
                                service: service.name,
                                scorecard: c.name,
                              })}
                            >
                              <ScoreBadge score={r.score} levelName={r.levelName} color={color} />
                            </button>
                          ) : (
                            <span className="text-xs text-on-surface-faint">
                              {scorecardAppliesTo(c, service.tier as ServiceTier | null)
                                ? gt("Pending")
                                : gt("Not applicable")}
                            </span>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section>
        <div className="flex items-center justify-between mb-2">
          <div>
            <h2 className="text-base font-semibold text-on-surface">{gt("Scorecards")}</h2>
            <p className="text-xs text-on-surface-faint">
              {gt("Scores are refreshed hourly. Evaluate now to see the effect of a change.")}
            </p>
          </div>
          {canWrite && (
            <button
              type="button"
              onClick={() => setEditing({ existing: null })}
              className={primaryButtonClass}
            >
              {gt("New scorecard")}
            </button>
          )}
        </div>
        {data !== null && data.scorecards.length === 0 && (
          <p className="text-sm text-on-surface-faint">
            {gt("No scorecards. Create one to start scoring services.")}
          </p>
        )}
        <ul className="space-y-2">
          {(data?.scorecards ?? []).map((card) => (
            <li
              key={card.id}
              className="rounded-xl border border-border bg-surface-raised px-4 py-3 flex items-start gap-3"
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-medium text-sm text-on-surface truncate">{card.name}</span>
                  {!card.enabled && (
                    <span className="text-xs text-on-surface-faint">{gt("Disabled")}</span>
                  )}
                  {card.isDefault && (
                    <span className="text-xs text-on-surface-faint">{gt("Default")}</span>
                  )}
                </div>
                {card.description && (
                  <p className="text-xs text-on-surface-secondary">{card.description}</p>
                )}
                <p className="mt-0.5 text-xs text-on-surface-faint">
                  {gt("{checks} checks · {levels} levels · {tiers}", {
                    checks: card.checks.length,
                    levels: card.levels.length,
                    tiers:
                      card.applicableTiers.length === 0
                        ? gt("every service")
                        : card.applicableTiers.map((t) => tierLabel(t)).join(", "),
                  })}
                  {card.lastEvaluatedAt
                    ? ` · ${gt("evaluated {when}", {
                        when: new Date(card.lastEvaluatedAt).toLocaleString(),
                      })}`
                    : ` · ${gt("not evaluated yet")}`}
                </p>
              </div>
              {canWrite && (
                <div className="flex items-center gap-1.5 shrink-0">
                  {client.evaluateScorecard && (
                    <button
                      type="button"
                      className={smallButtonClass}
                      disabled={busy === card.id}
                      onClick={() => void evaluate(card)}
                    >
                      {busy === card.id ? gt("Evaluating…") : gt("Evaluate now")}
                    </button>
                  )}
                  <button
                    type="button"
                    className={smallButtonClass}
                    onClick={() => setEditing({ existing: card })}
                  >
                    {gt("Edit")}
                  </button>
                  <button
                    type="button"
                    className={`${smallButtonClass} text-danger`}
                    disabled={busy === card.id}
                    onClick={() => void remove(card)}
                  >
                    {gt("Delete")}
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      </section>

      {editing && (
        <ScorecardEditorModal
          client={client}
          existing={editing.existing}
          onSaved={() => reload()}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}
