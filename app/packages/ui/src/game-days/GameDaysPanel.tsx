import { useCallback, useEffect, useState } from "react";
import { useGT } from "gt-react";
import {
  GAME_DAY_ACTIVE_STATUSES,
  computeGameDayReport,
  formatGameDayDuration,
  gameDayAbortable,
  gameDayEditable,
  type GameDay,
  type GameDayDetail,
  type GameDayInput,
  type GameDayPlan,
} from "@infrawrench/client-core";
import { BlastRadiusSummary } from "../blast-radius/BlastRadiusSummary.js";
import { Modal } from "../components/Modal.js";
import { GameDayEditorModal } from "./GameDayEditorModal.js";
import { GameDayPlanView } from "./GameDayPlanView.js";
import {
  gameDayDetectorLabel,
  gameDayEndReasonLabel,
  gameDayStatusClass,
  gameDayStatusLabel,
  gameDayTargetStateLabel,
} from "./labels.js";
import type { GameDaysClient } from "./types.js";

export interface GameDaysPanelProps {
  client: GameDaysClient;
  /** The game day whose report is open; undefined shows the list. */
  gameDayId?: string | undefined;
  /** Open a game day (or go back to the list with null). Hosts mirror it into the URL. */
  onGameDayChange: (gameDayId: string | null) => void;
}

/** How often a game day in flight is re-read. */
const LIVE_REFRESH_MS = 5_000;

const buttonClass =
  "rounded-lg border border-border bg-surface-raised px-3 py-1.5 text-sm text-on-surface hover:border-border-strong disabled:opacity-50";
const dangerButtonClass =
  "rounded-lg bg-red-600 hover:bg-red-700 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50";

const isActive = (g: GameDay) => GAME_DAY_ACTIVE_STATUSES.includes(g.status);

function formatInstant(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString() : "-";
}

/** The saved game day as the input it was written from, for the dry run and the confirmation. */
export function gameDayToInput(g: GameDay): GameDayInput {
  return {
    name: g.name,
    description: g.description,
    serviceId: g.serviceId,
    targets: g.targets.map((t) => ({ resourceId: t.resourceId, actionId: t.actionId })),
    startsAt: g.startsAt,
    durationMinutes: g.durationMinutes,
    recoveryTimeoutMinutes: g.recoveryTimeoutMinutes,
    freezeDuringRun: g.freezeDuringRun,
    watchedProbeIds: g.watchedProbes.map((p) => p.id),
    watchedSloIds: g.watchedSloIds,
  };
}

function StatusBadge({ gameDay }: { gameDay: GameDay }) {
  const gt = useGT();
  return (
    <span
      className={`rounded-md px-2 py-0.5 text-xs font-medium whitespace-nowrap ${gameDayStatusClass(gameDay.status)}`}
    >
      {gameDayStatusLabel(gameDay.status, gt)}
    </span>
  );
}

/** Game days: list, report, and every control a person has over one. */
export function GameDaysPanel({ client, gameDayId, onGameDayChange }: GameDaysPanelProps) {
  const gt = useGT();
  const [list, setList] = useState<GameDay[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<GameDay | "new" | null>(null);

  const loadList = useCallback(async () => {
    try {
      setList(await client.listGameDays());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [client]);

  useEffect(() => {
    if (gameDayId) return;
    void loadList();
  }, [gameDayId, loadList]);

  // Keep a list with something in flight current.
  const anyActive = (list ?? []).some(isActive);
  useEffect(() => {
    if (gameDayId || !anyActive) return;
    const timer = setInterval(() => void loadList(), LIVE_REFRESH_MS);
    return () => clearInterval(timer);
  }, [gameDayId, anyActive, loadList]);

  if (gameDayId) {
    return (
      <GameDayDetailView
        client={client}
        gameDayId={gameDayId}
        onBack={() => onGameDayChange(null)}
        onDeleted={() => onGameDayChange(null)}
      />
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-lg font-semibold text-on-surface">{gt("Game days")}</h1>
        {client.createGameDay && (
          <button
            type="button"
            onClick={() => setEditing("new")}
            className="rounded-lg bg-accent hover:bg-accent-hover px-3 py-1.5 text-sm text-on-accent"
          >
            {gt("New game day")}
          </button>
        )}
      </div>
      {error !== null && (
        <div role="alert" className="text-sm text-danger">
          {error}
        </div>
      )}
      {list === null ? (
        <p className="text-sm text-on-surface-faint">{gt("Loading…")}</p>
      ) : list.length === 0 ? (
        <p className="text-sm text-on-surface-faint">{gt("No game days yet.")}</p>
      ) : (
        <ul className="divide-y divide-border/50 rounded-xl border border-border">
          {list.map((g) => {
            const report = computeGameDayReport(g);
            return (
              <li key={g.id}>
                <button
                  type="button"
                  onClick={() => onGameDayChange(g.id)}
                  className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-surface-raised/50"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-on-surface">
                      {g.name}
                    </span>
                    <span className="block text-xs text-on-surface-tertiary">
                      {formatInstant(g.injectedAt ?? g.startsAt)}
                      {g.serviceName ? ` · ${g.serviceName}` : ""}
                    </span>
                  </span>
                  {report.state !== "not_run" && (
                    <span className="text-xs text-on-surface-secondary whitespace-nowrap">
                      {report.timeToDetectMs === null
                        ? gt("Not detected")
                        : gt("Detected in {time}", {
                            time: formatGameDayDuration(report.timeToDetectMs),
                          })}
                    </span>
                  )}
                  <StatusBadge gameDay={g} />
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {editing !== null && (
        <GameDayEditorModal
          client={client}
          existing={editing === "new" ? undefined : editing}
          onClose={() => setEditing(null)}
          onSaved={(saved) => {
            void loadList();
            onGameDayChange(saved.id);
          }}
        />
      )}
    </div>
  );
}

function GameDayDetailView({
  client,
  gameDayId,
  onBack,
  onDeleted,
}: {
  client: GameDaysClient;
  gameDayId: string;
  onBack: () => void;
  onDeleted: () => void;
}) {
  const gt = useGT();
  const [detail, setDetail] = useState<GameDayDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [arming, setArming] = useState(false);
  const [plan, setPlan] = useState<GameDayPlan | null>(null);

  const load = useCallback(async () => {
    try {
      setDetail(await client.getGameDay(gameDayId));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [client, gameDayId]);

  useEffect(() => {
    setDetail(null);
    setPlan(null);
    void load();
  }, [load]);

  const live = detail !== null && isActive(detail.gameDay);
  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => void load(), LIVE_REFRESH_MS);
    return () => clearInterval(timer);
  }, [live, load]);

  const act = async (run: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await run();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const back = (
    <button type="button" onClick={onBack} className="text-sm text-accent hover:underline">
      {gt("All game days")}
    </button>
  );

  if (!detail) {
    return (
      <div className="flex flex-col gap-3">
        {back}
        {error !== null ? (
          <div role="alert" className="text-sm text-danger">
            {error}
          </div>
        ) : (
          <p className="text-sm text-on-surface-faint">{gt("Loading…")}</p>
        )}
      </div>
    );
  }

  const g = detail.gameDay;
  const report = detail.report;
  const abortable = gameDayAbortable(g.status) && client.abortGameDay;

  return (
    <div className="flex flex-col gap-4">
      {back}
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-lg font-semibold text-on-surface">{g.name}</h1>
        <StatusBadge gameDay={g} />
        {g.endReason && (
          <span className="text-xs text-on-surface-tertiary">
            {gameDayEndReasonLabel(g.endReason, gt)}
          </span>
        )}
      </div>
      {g.description && <p className="text-sm text-on-surface-secondary">{g.description}</p>}

      {abortable && (
        <div className="flex flex-wrap items-center gap-3 rounded-xl border border-red-500/40 bg-red-500/5 p-4">
          <span className="flex-1 text-sm text-on-surface">
            {g.status === "armed"
              ? gt("Starts {time}", { time: formatInstant(g.startsAt) })
              : g.endsAt && g.status === "running"
                ? gt("Undone automatically at {time}", { time: formatInstant(g.endsAt) })
                : gameDayStatusLabel(g.status, gt)}
          </span>
          <button
            type="button"
            disabled={busy}
            onClick={() => void act(() => client.abortGameDay!(g.id))}
            className={dangerButtonClass}
          >
            {gt("Abort")}
          </button>
        </div>
      )}

      {g.lastError && (
        <div role="alert" className="text-sm text-danger">
          {g.lastError}
        </div>
      )}
      {error !== null && (
        <div role="alert" className="text-sm text-danger">
          {error}
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        {gameDayEditable(g.status) && client.updateGameDay && (
          <button type="button" className={buttonClass} onClick={() => setEditing(true)}>
            {gt("Edit")}
          </button>
        )}
        {(g.status === "planned" || g.status === "armed") && client.planGameDay && (
          <button
            type="button"
            className={buttonClass}
            disabled={busy}
            onClick={() =>
              void act(async () => setPlan(await client.planGameDay!(gameDayToInput(g))))
            }
          >
            {gt("Dry run")}
          </button>
        )}
        {g.status === "planned" && client.armGameDay && (
          <button
            type="button"
            className="rounded-lg bg-accent hover:bg-accent-hover px-3 py-1.5 text-sm text-on-accent"
            onClick={() => setArming(true)}
          >
            {gt("Arm")}
          </button>
        )}
        {g.status === "armed" && client.disarmGameDay && (
          <button
            type="button"
            className={buttonClass}
            disabled={busy}
            onClick={() => void act(() => client.disarmGameDay!(g.id))}
          >
            {gt("Disarm")}
          </button>
        )}
        {g.status === "running" && client.endGameDay && (
          <button
            type="button"
            className={buttonClass}
            disabled={busy}
            onClick={() => void act(() => client.endGameDay!(g.id))}
          >
            {gt("End now")}
          </button>
        )}
        {g.status === "undo_failed" && client.retryUndo && (
          <button
            type="button"
            className={buttonClass}
            disabled={busy}
            onClick={() => void act(() => client.retryUndo!(g.id))}
          >
            {gt("Retry undo")}
          </button>
        )}
        {(g.status === "planned" || g.status === "completed" || g.status === "cancelled") &&
          client.deleteGameDay && (
            <button
              type="button"
              className={buttonClass}
              disabled={busy}
              onClick={() =>
                void act(async () => {
                  await client.deleteGameDay!(g.id);
                  onDeleted();
                })
              }
            >
              {gt("Delete")}
            </button>
          )}
      </div>

      {plan && <GameDayPlanView plan={plan} />}

      {report.state !== "not_run" && (
        <section aria-label={gt("Report")} className="flex flex-col gap-3">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {[
              { label: gt("Time to detect"), value: report.timeToDetectMs },
              { label: gt("Time to page"), value: report.timeToPageMs },
              { label: gt("Time to acknowledge"), value: report.timeToAcknowledgeMs },
              { label: gt("Time to recover"), value: report.timeToRecoverMs },
            ].map((tile) => (
              <div key={tile.label} className="rounded-xl border border-border p-3">
                <div className="text-xs text-on-surface-tertiary">{tile.label}</div>
                <div className="mt-1 text-lg font-semibold text-on-surface">
                  {tile.value === null ? gt("Not measured") : formatGameDayDuration(tile.value)}
                </div>
              </div>
            ))}
          </div>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-on-surface-tertiary">
                <th className="py-1 font-medium">{gt("Detector")}</th>
                <th className="py-1 font-medium">{gt("Fired")}</th>
                <th className="py-1 font-medium">{gt("After injection")}</th>
              </tr>
            </thead>
            <tbody>
              {report.detectors.map((row) => (
                <tr key={row.detector} className="border-t border-border/50">
                  <td className="py-1.5 text-on-surface">
                    {gameDayDetectorLabel(row.detector, gt)}
                  </td>
                  <td className="py-1.5">
                    {row.at ? (
                      <span className="text-success">{formatInstant(row.at)}</span>
                    ) : row.measurable ? (
                      <span className="text-danger">{gt("Did not fire")}</span>
                    ) : (
                      <span className="text-on-surface-faint">{gt("Not set up")}</span>
                    )}
                  </td>
                  <td className="py-1.5 text-on-surface-secondary">
                    {row.afterMs === null ? "-" : formatGameDayDuration(row.afterMs)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      <section aria-label={gt("Targets")}>
        <h2 className="text-sm font-semibold text-on-surface">{gt("Targets")}</h2>
        <table className="mt-2 w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-on-surface-tertiary">
              <th className="py-1 font-medium">{gt("Resource")}</th>
              <th className="py-1 font-medium">{gt("Failure")}</th>
              <th className="py-1 font-medium">{gt("State")}</th>
              <th className="py-1 font-medium">{gt("Before")}</th>
            </tr>
          </thead>
          <tbody>
            {g.targets.map((t) => (
              <tr key={t.id} className="border-t border-border/50 align-top">
                <td className="py-1.5 text-on-surface">{t.displayName}</td>
                <td className="py-1.5 text-on-surface-secondary" title={t.undoLabel}>
                  {t.actionLabel}
                </td>
                <td className="py-1.5">
                  {gameDayTargetStateLabel(t.state, gt)}
                  {t.lastError && <span className="block text-xs text-danger">{t.lastError}</span>}
                </td>
                <td className="py-1.5 text-on-surface-tertiary">{t.stateBefore ?? "-"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section aria-label={gt("Timeline")} className="text-sm">
        <h2 className="text-sm font-semibold text-on-surface">{gt("Timeline")}</h2>
        <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
          <dt className="text-on-surface-tertiary">{gt("Scheduled")}</dt>
          <dd>{formatInstant(g.startsAt)}</dd>
          <dt className="text-on-surface-tertiary">{gt("Armed")}</dt>
          <dd>
            {formatInstant(g.armedAt)}
            {g.armedByEmail ? ` · ${g.armedByEmail}` : ""}
          </dd>
          <dt className="text-on-surface-tertiary">{gt("Injected")}</dt>
          <dd>{formatInstant(g.injectedAt)}</dd>
          <dt className="text-on-surface-tertiary">{gt("Undone")}</dt>
          <dd>{formatInstant(g.undoneAt)}</dd>
          <dt className="text-on-surface-tertiary">{gt("Recovered")}</dt>
          <dd>{formatInstant(g.recoveredAt)}</dd>
        </dl>
        {g.watchedProbes.length > 0 && (
          <p className="mt-2 text-xs text-on-surface-tertiary">
            {gt("Watched probes: {names}", {
              names: g.watchedProbes.map((p) => p.name).join(", "),
            })}
          </p>
        )}
      </section>

      {detail.alerts.length > 0 && (
        <section aria-label={gt("Alerts during the game day")}>
          <h2 className="text-sm font-semibold text-on-surface">
            {gt("Alerts during the game day")}
          </h2>
          <ul className="mt-2 flex flex-col gap-1 text-sm">
            {detail.alerts.map((a) => (
              <li key={a.id} className="flex flex-wrap items-baseline gap-2">
                <span className="text-xs text-on-surface-tertiary whitespace-nowrap">
                  {formatInstant(a.at)}
                </span>
                <span className={a.related ? "text-on-surface" : "text-on-surface-faint"}>
                  {a.title}
                </span>
                {a.paged && <span className="text-xs text-warning">{gt("paged")}</span>}
                {a.unrouted && (
                  <span className="text-xs text-danger">{gt("no rule sent it anywhere")}</span>
                )}
                {!a.related && (
                  <span className="text-xs text-on-surface-faint">{gt("unrelated")}</span>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {editing && (
        <GameDayEditorModal
          client={client}
          existing={g}
          onClose={() => setEditing(false)}
          onSaved={() => void load()}
        />
      )}
      {arming && (
        <ArmGameDayModal
          client={client}
          gameDay={g}
          onClose={() => setArming(false)}
          onArmed={() => void load()}
        />
      )}
    </div>
  );
}

/**
 * The confirmation: the dry run and each target's blast radius, then the
 * game day's name typed out. Nothing runs without a person passing this.
 */
function ArmGameDayModal({
  client,
  gameDay,
  onClose,
  onArmed,
}: {
  client: GameDaysClient;
  gameDay: GameDay;
  onClose: () => void;
  onArmed: () => void;
}) {
  const gt = useGT();
  const [plan, setPlan] = useState<GameDayPlan | null>(null);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!client.planGameDay) return;
    let cancelled = false;
    client
      .planGameDay(gameDayToInput(gameDay))
      .then((p) => {
        if (!cancelled) setPlan(p);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [client, gameDay]);

  const arm = async () => {
    setBusy(true);
    setError(null);
    try {
      await client.armGameDay!(gameDay.id, typed);
      onArmed();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal onClose={() => !busy && onClose()} ariaLabel={gt("Arm game day")}>
      <div className="w-[36rem] max-w-[94vw] max-h-[90vh] overflow-y-auto rounded-2xl border border-border bg-surface p-5 shadow-xl">
        <h2 className="text-sm font-semibold text-on-surface">{gt("Arm game day")}</h2>
        <p className="mt-1 text-sm text-on-surface-secondary">
          {gt("Injects at {time} and undoes after {minutes} minutes.", {
            time: formatInstant(gameDay.startsAt),
            minutes: gameDay.durationMinutes,
          })}
        </p>
        <div className="mt-3 flex flex-col gap-3">
          {plan ? (
            <GameDayPlanView plan={plan} />
          ) : (
            client.planGameDay && (
              <p className="text-xs text-on-surface-faint">{gt("Running the dry run…")}</p>
            )
          )}
          {client.blastRadius &&
            gameDay.targets.map((t) => (
              <div key={t.id}>
                <h3 className="mb-1 text-xs font-semibold text-on-surface-secondary">
                  {t.displayName}
                </h3>
                <BlastRadiusSummary client={client.blastRadius} resourceId={t.resourceId} />
              </div>
            ))}
          <div>
            <label
              className="block text-xs font-medium text-on-surface-secondary mb-1"
              htmlFor="game-day-confirm"
            >
              {gt("Type {name} to confirm", { name: gameDay.name })}
            </label>
            <input
              id="game-day-confirm"
              type="text"
              autoComplete="off"
              className="w-full rounded-lg border border-border bg-surface-raised px-3 py-1.5 text-sm text-on-surface focus:outline-none focus:border-accent"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
            />
          </div>
          {error !== null && (
            <div role="alert" className="text-sm text-danger">
              {error}
            </div>
          )}
          <div className="flex justify-end gap-2">
            <button type="button" className={buttonClass} disabled={busy} onClick={onClose}>
              {gt("Cancel")}
            </button>
            <button
              type="button"
              disabled={busy || typed.trim() !== gameDay.name}
              onClick={() => void arm()}
              className={dangerButtonClass}
            >
              {busy ? gt("Arming…") : gt("Arm game day")}
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
