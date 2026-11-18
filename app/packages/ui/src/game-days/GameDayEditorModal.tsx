import { useEffect, useMemo, useState } from "react";
import { useGT } from "gt-react";
import {
  GAME_DAY_LIMITS,
  type GameDay,
  type GameDayCandidates,
  type GameDayInput,
  type GameDayPlan,
} from "@infrawrench/client-core";
import { decodeForm, GameDayInput as GameDayInputSchema } from "@infrawrench/api-contract/schemas";
import { Modal } from "../components/Modal.js";
import { GameDayPlanView } from "./GameDayPlanView.js";
import type { GameDaysClient } from "./types.js";

const inputClass =
  "w-full rounded-lg border border-border bg-surface-raised px-3 py-1.5 text-sm text-on-surface focus:outline-none focus:border-accent";
const labelClass = "block text-xs font-medium text-on-surface-secondary mb-1";

const pad = (n: number) => String(n).padStart(2, "0");

/** An instant as a `datetime-local` value in the browser's zone. */
function toLocalInput(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** The next whole hour, at least thirty minutes away. */
function defaultStart(): string {
  const d = new Date(Date.now() + 30 * 60_000);
  d.setMinutes(0, 0, 0);
  d.setHours(d.getHours() + 1);
  return d.toISOString();
}

interface TargetRow {
  resourceId: string;
  actionId: string;
}

export interface GameDayEditorModalProps {
  client: GameDaysClient;
  /** The game day being edited; omitted for a new one. */
  existing?: GameDay | undefined;
  onClose: () => void;
  onSaved: (gameDay: GameDay) => void;
}

/** Plan or edit a game day. Saving never arms it: that is a separate confirmation. */
export function GameDayEditorModal({ client, existing, onClose, onSaved }: GameDayEditorModalProps) {
  const gt = useGT();
  const [candidates, setCandidates] = useState<GameDayCandidates | null>(null);
  const [name, setName] = useState(existing?.name ?? "");
  const [description, setDescription] = useState(existing?.description ?? "");
  const [serviceId, setServiceId] = useState(existing?.serviceId ?? "");
  const [targets, setTargets] = useState<TargetRow[]>(
    existing?.targets.map((t) => ({ resourceId: t.resourceId, actionId: t.actionId })) ?? [
      { resourceId: "", actionId: "" },
    ],
  );
  const [startsAt, setStartsAt] = useState(toLocalInput(existing?.startsAt ?? defaultStart()));
  const [duration, setDuration] = useState(
    String(existing?.durationMinutes ?? GAME_DAY_LIMITS.durationMinutesDefault),
  );
  const [recovery, setRecovery] = useState(
    String(existing?.recoveryTimeoutMinutes ?? GAME_DAY_LIMITS.recoveryTimeoutMinutesDefault),
  );
  const [freeze, setFreeze] = useState(existing?.freezeDuringRun ?? false);
  const [probeIds, setProbeIds] = useState<string[]>(
    existing?.watchedProbes.map((p) => p.id) ?? [],
  );
  const [sloIds, setSloIds] = useState<string[]>(existing?.watchedSloIds ?? []);
  const [plan, setPlan] = useState<GameDayPlan | null>(null);
  const [planning, setPlanning] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    client
      .listCandidates()
      .then((c) => {
        if (!cancelled) setCandidates(c);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [client]);

  const service = candidates?.services.find((s) => s.id === serviceId) ?? null;
  // With a service picked, its members are grouped first; anything else stays pickable.
  const resources = useMemo(() => candidates?.resources ?? [], [candidates]);
  const byId = useMemo(() => new Map(resources.map((r) => [r.resourceId, r])), [resources]);

  const build = (): GameDayInput | string => {
    const parsed = decodeForm(GameDayInputSchema, {
      name: name.trim(),
      description: description.trim() ? description.trim() : null,
      serviceId: serviceId || null,
      targets: targets.filter((t) => t.resourceId && t.actionId),
      startsAt: new Date(startsAt).toISOString(),
      durationMinutes: Number(duration),
      recoveryTimeoutMinutes: Number(recovery),
      freezeDuringRun: freeze,
      watchedProbeIds: probeIds,
      watchedSloIds: sloIds,
    });
    return parsed.success ? parsed.data : parsed.message || gt("Invalid game day");
  };

  const runPlan = async () => {
    const input = build();
    if (typeof input === "string") {
      setError(input);
      return;
    }
    if (!client.planGameDay) return;
    setPlanning(true);
    setError(null);
    try {
      setPlan(await client.planGameDay(input));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPlanning(false);
    }
  };

  const save = async () => {
    const input = build();
    if (typeof input === "string") {
      setError(input);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const saved = existing
        ? await client.updateGameDay!(existing.id, input)
        : await client.createGameDay!(input);
      onSaved(saved);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : gt("Failed to save the game day"));
    } finally {
      setSaving(false);
    }
  };

  const dismiss = () => {
    if (!saving) onClose();
  };

  const toggle = (list: string[], id: string, on: boolean) =>
    on ? [...new Set([...list, id])] : list.filter((x) => x !== id);

  return (
    <Modal onClose={dismiss} ariaLabel={existing ? gt("Edit game day") : gt("New game day")}>
      <div className="w-[40rem] max-w-[94vw] max-h-[90vh] overflow-y-auto rounded-2xl border border-border bg-surface p-5 shadow-xl">
        <h2 className="text-sm font-semibold text-on-surface">
          {existing ? gt("Edit game day") : gt("New game day")}
        </h2>

        <div className="mt-4 flex flex-col gap-3">
          <div>
            <label className={labelClass} htmlFor="game-day-name">
              {gt("Name")}
            </label>
            <input
              id="game-day-name"
              type="text"
              maxLength={GAME_DAY_LIMITS.nameMax}
              className={inputClass}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={gt("Checkout without its cache")}
            />
          </div>
          <div>
            <label className={labelClass} htmlFor="game-day-description">
              {gt("Hypothesis (optional)")}
            </label>
            <textarea
              id="game-day-description"
              rows={2}
              maxLength={GAME_DAY_LIMITS.descriptionMax}
              className={inputClass}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={gt("A probe pages on-call within five minutes")}
            />
          </div>
          <div>
            <label className={labelClass} htmlFor="game-day-service">
              {gt("Service (optional)")}
            </label>
            <select
              id="game-day-service"
              className={inputClass}
              value={serviceId}
              onChange={(e) => setServiceId(e.target.value)}
            >
              <option value="">{gt("No service")}</option>
              {(candidates?.services ?? []).map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </div>

          <fieldset>
            <legend className={labelClass}>{gt("What to break")}</legend>
            <div className="flex flex-col gap-2">
              {targets.map((row, index) => {
                const resource = byId.get(row.resourceId);
                return (
                  <div key={index} className="flex gap-2">
                    <select
                      aria-label={gt("Resource")}
                      className={inputClass}
                      value={row.resourceId}
                      onChange={(e) => {
                        const picked = byId.get(e.target.value);
                        setTargets((all) =>
                          all.map((t, i) =>
                            i === index
                              ? {
                                  resourceId: e.target.value,
                                  actionId: picked?.actions[0]?.actionId ?? "",
                                }
                              : t,
                          ),
                        );
                      }}
                    >
                      <option value="" disabled>
                        {candidates === null
                          ? gt("Loading resources…")
                          : resources.length > 0
                            ? gt("Pick a resource…")
                            : gt("No synced resource supports a reversible failure")}
                      </option>
                      {service ? (
                        <>
                          <optgroup label={gt("In {service}", { service: service.name })}>
                            {resources
                              .filter((r) => service.resourceIds.includes(r.resourceId))
                              .map((r) => (
                                <option key={r.resourceId} value={r.resourceId}>
                                  {r.displayName}
                                </option>
                              ))}
                          </optgroup>
                          <optgroup label={gt("Other resources")}>
                            {resources
                              .filter((r) => !service.resourceIds.includes(r.resourceId))
                              .map((r) => (
                                <option key={r.resourceId} value={r.resourceId}>
                                  {r.displayName}
                                </option>
                              ))}
                          </optgroup>
                        </>
                      ) : (
                        resources.map((r) => (
                          <option key={r.resourceId} value={r.resourceId}>
                            {r.displayName}
                          </option>
                        ))
                      )}
                    </select>
                    <select
                      aria-label={gt("Failure")}
                      className={inputClass}
                      value={row.actionId}
                      disabled={!resource}
                      onChange={(e) =>
                        setTargets((all) =>
                          all.map((t, i) => (i === index ? { ...t, actionId: e.target.value } : t)),
                        )
                      }
                    >
                      {(resource?.actions ?? []).map((a) => (
                        <option key={a.actionId} value={a.actionId} title={a.undoLabel}>
                          {a.label}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      aria-label={gt("Remove target")}
                      disabled={targets.length === 1}
                      onClick={() => setTargets((all) => all.filter((_, i) => i !== index))}
                      className="rounded-lg border border-border px-2 text-on-surface-tertiary hover:text-on-surface disabled:opacity-40"
                    >
                      <svg
                        aria-hidden="true"
                        viewBox="0 0 24 24"
                        className="h-4 w-4"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <path d="M18 6 6 18" />
                        <path d="m6 6 12 12" />
                      </svg>
                    </button>
                  </div>
                );
              })}
            </div>
            {targets.length < GAME_DAY_LIMITS.targetsMax && (
              <button
                type="button"
                onClick={() => setTargets((all) => [...all, { resourceId: "", actionId: "" }])}
                className="mt-2 text-xs text-accent hover:underline"
              >
                {gt("Add a target")}
              </button>
            )}
          </fieldset>

          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className={labelClass} htmlFor="game-day-start">
                {gt("Starts")}
              </label>
              <input
                id="game-day-start"
                type="datetime-local"
                className={inputClass}
                value={startsAt}
                onChange={(e) => setStartsAt(e.target.value)}
              />
            </div>
            <div>
              <label className={labelClass} htmlFor="game-day-duration">
                {gt("Time limit (minutes)")}
              </label>
              <input
                id="game-day-duration"
                type="number"
                min={GAME_DAY_LIMITS.durationMinutesMin}
                max={GAME_DAY_LIMITS.durationMinutesMax}
                className={inputClass}
                value={duration}
                onChange={(e) => setDuration(e.target.value)}
              />
            </div>
            <div>
              <label className={labelClass} htmlFor="game-day-recovery">
                {gt("Recovery wait (minutes)")}
              </label>
              <input
                id="game-day-recovery"
                type="number"
                min={GAME_DAY_LIMITS.recoveryTimeoutMinutesMin}
                max={GAME_DAY_LIMITS.recoveryTimeoutMinutesMax}
                className={inputClass}
                value={recovery}
                onChange={(e) => setRecovery(e.target.value)}
              />
            </div>
          </div>

          <fieldset>
            <legend className={labelClass}>{gt("Watched probes")}</legend>
            {candidates && candidates.probes.length === 0 ? (
              <p className="text-xs text-on-surface-faint">{gt("No probes yet")}</p>
            ) : (
              <div className="max-h-32 overflow-y-auto flex flex-col gap-1">
                {(candidates?.probes ?? []).map((p) => (
                  <label key={p.id} className="flex items-center gap-2 text-sm text-on-surface">
                    <input
                      type="checkbox"
                      checked={probeIds.includes(p.id)}
                      onChange={(e) => setProbeIds((l) => toggle(l, p.id, e.target.checked))}
                    />
                    {p.name}
                  </label>
                ))}
              </div>
            )}
          </fieldset>

          {candidates && candidates.slos.length > 0 && (
            <fieldset>
              <legend className={labelClass}>{gt("Watched SLOs")}</legend>
              <div className="max-h-32 overflow-y-auto flex flex-col gap-1">
                {candidates.slos.map((s) => (
                  <label key={s.id} className="flex items-center gap-2 text-sm text-on-surface">
                    <input
                      type="checkbox"
                      checked={sloIds.includes(s.id)}
                      onChange={(e) => setSloIds((l) => toggle(l, s.id, e.target.checked))}
                    />
                    {s.name}
                  </label>
                ))}
              </div>
            </fieldset>
          )}

          <label className="flex items-center gap-2 text-sm text-on-surface">
            <input type="checkbox" checked={freeze} onChange={(e) => setFreeze(e.target.checked)} />
            {gt("Start a change freeze while it runs")}
          </label>

          {plan && <GameDayPlanView plan={plan} />}

          {error !== null && (
            <div role="alert" className="text-sm text-danger">
              {error}
            </div>
          )}

          <div className="mt-1 flex justify-end gap-2">
            <button
              type="button"
              onClick={dismiss}
              disabled={saving}
              className="rounded-lg border border-border bg-surface-raised px-3 py-1.5 text-sm text-on-surface hover:border-border-strong disabled:opacity-50"
            >
              {gt("Cancel")}
            </button>
            {client.planGameDay && (
              <button
                type="button"
                onClick={() => void runPlan()}
                disabled={planning || saving}
                className="rounded-lg border border-border bg-surface-raised px-3 py-1.5 text-sm text-on-surface hover:border-border-strong disabled:opacity-50"
              >
                {planning ? gt("Checking…") : gt("Dry run")}
              </button>
            )}
            <button
              type="button"
              onClick={() => void save()}
              disabled={saving}
              className="rounded-lg bg-accent hover:bg-accent-hover px-3 py-1.5 text-sm text-on-accent disabled:opacity-50"
            >
              {saving ? gt("Saving…") : existing ? gt("Save") : gt("Plan game day")}
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
