import { useEffect, useMemo, useState } from "react";
import { useGT } from "gt-react";
import {
  HEARTBEAT_DEFAULTS,
  HEARTBEAT_LIMITS,
  heartbeatScheduleOf,
  nextCronOccurrences,
  validateHeartbeatSchedule,
  type Heartbeat,
  type HeartbeatSchedule,
  type HeartbeatScheduleKind,
  type HeartbeatSuggestion,
} from "@infrawrench/client-core";
import { Modal } from "../components/Modal.js";
import { formatWhen } from "./format.js";
import type { HeartbeatSeed, HeartbeatsClient } from "./types.js";

const inputClass =
  "w-full rounded-lg border border-border bg-surface-sunken px-2.5 py-1.5 text-sm text-on-surface focus:outline-none focus:border-accent-subtle";
const labelClass = "block text-xs font-medium text-on-surface-secondary mb-1";

export interface HeartbeatEditorModalProps {
  client: HeartbeatsClient;
  /** Existing heartbeat to edit, or null to create one. */
  existing: Heartbeat | null;
  /** Start a new heartbeat from a scheduled resource (the resource tab's button). */
  seed?: HeartbeatSeed | undefined;
  onSaved: (heartbeat: Heartbeat | null) => void;
  onClose: () => void;
}

/** The `<select>` value for "write the schedule yourself". */
const CUSTOM = "__custom__";

function parseFieldInt(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  const n = Number(trimmed);
  return Number.isInteger(n) ? n : null;
}

function suggestionKey(s: HeartbeatSuggestion): string {
  return `${s.resourceId}::${s.fieldKey}`;
}

/** Every IANA zone the runtime knows, for the zone field's suggestions. */
function knownTimezones(): string[] {
  const intl = Intl as unknown as { supportedValuesOf?: (key: string) => string[] };
  try {
    return intl.supportedValuesOf?.("timeZone") ?? [];
  } catch {
    return [];
  }
}

/**
 * The heartbeat editor. Its source field is a picker first: every scheduled
 * job, pipeline and function the org's plugins report, with its schedule read
 * and filled in, so nobody has to copy a cron expression out of a provider's
 * console. A custom schedule is the fallback.
 */
export function HeartbeatEditorModal({
  client,
  existing,
  seed,
  onSaved,
  onClose,
}: HeartbeatEditorModalProps) {
  const gt = useGT();
  const initialSchedule: HeartbeatSchedule | null = existing
    ? heartbeatScheduleOf(existing)
    : (seed?.suggestion.schedule ?? null);
  const [name, setName] = useState(existing?.name ?? seed?.name ?? "");
  const [kind, setKind] = useState<HeartbeatScheduleKind>(
    initialSchedule?.kind ?? (seed ? "cron" : HEARTBEAT_DEFAULTS.scheduleKind),
  );
  const [cronExpression, setCronExpression] = useState(
    initialSchedule?.kind === "cron"
      ? initialSchedule.cronExpression
      : seed && !seed.suggestion.schedule
        ? seed.suggestion.rawSchedule
        : "",
  );
  const [timezone, setTimezone] = useState<string>(
    initialSchedule?.kind === "cron" ? initialSchedule.timezone : HEARTBEAT_DEFAULTS.timezone,
  );
  const [intervalMinutes, setIntervalMinutes] = useState(
    String(
      initialSchedule?.kind === "interval"
        ? initialSchedule.intervalMinutes
        : HEARTBEAT_DEFAULTS.intervalMinutes,
    ),
  );
  const [graceMinutes, setGraceMinutes] = useState(
    String(existing?.graceMinutes ?? HEARTBEAT_DEFAULTS.graceMinutes),
  );
  // null = loading; [] = loaded, nothing to suggest.
  const [suggestions, setSuggestions] = useState<HeartbeatSuggestion[] | null>(
    seed ? [seed.suggestion] : null,
  );
  const [picked, setPicked] = useState<string>(
    seed ? suggestionKey(seed.suggestion) : existing ? CUSTOM : "",
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const zones = useMemo(knownTimezones, []);

  useEffect(() => {
    if (existing || seed) return undefined;
    let cancelled = false;
    client
      .listSuggestions()
      .then((list) => {
        if (!cancelled) setSuggestions(list);
      })
      .catch(() => {
        if (!cancelled) setSuggestions([]);
      });
    return () => {
      cancelled = true;
    };
  }, [client, existing, seed]);

  const pickedSuggestion = useMemo(
    () => suggestions?.find((s) => suggestionKey(s) === picked) ?? null,
    [suggestions, picked],
  );

  const pick = (value: string) => {
    setPicked(value);
    const suggestion = suggestions?.find((s) => suggestionKey(s) === value);
    if (!suggestion) return;
    if (!name.trim()) setName(suggestion.displayName);
    const schedule = suggestion.schedule;
    if (schedule?.kind === "cron") {
      setKind("cron");
      setCronExpression(schedule.cronExpression);
      setTimezone(schedule.timezone);
    } else if (schedule?.kind === "interval") {
      setKind("interval");
      setIntervalMinutes(String(schedule.intervalMinutes));
    } else {
      setKind("cron");
      setCronExpression(suggestion.rawSchedule);
    }
  };

  const intervalNum = parseFieldInt(intervalMinutes);
  const graceNum = parseFieldInt(graceMinutes);
  const schedule: HeartbeatSchedule =
    kind === "cron"
      ? { kind: "cron", cronExpression: cronExpression.trim(), timezone: timezone.trim() }
      : { kind: "interval", intervalMinutes: intervalNum ?? 0 };
  const scheduleProblem =
    kind === "interval" && intervalNum === null
      ? gt("The interval must be a whole number of minutes.")
      : validateHeartbeatSchedule(schedule);
  const graceProblem =
    graceNum === null ||
    graceNum < HEARTBEAT_LIMITS.minGraceMinutes ||
    graceNum > HEARTBEAT_LIMITS.maxGraceMinutes
      ? gt("The grace period must be {min} to {max} minutes.", {
          min: HEARTBEAT_LIMITS.minGraceMinutes,
          max: HEARTBEAT_LIMITS.maxGraceMinutes,
        })
      : null;

  const preview = useMemo(() => {
    if (kind !== "cron" || scheduleProblem !== null) return [];
    try {
      return nextCronOccurrences(cronExpression.trim(), 3, { timezone: timezone.trim() });
    } catch {
      return [];
    }
  }, [kind, cronExpression, timezone, scheduleProblem]);

  const save = async () => {
    if (!name.trim()) {
      setError(gt("A name is required."));
      return;
    }
    if (scheduleProblem !== null || graceProblem !== null || graceNum === null) {
      setError(scheduleProblem ?? graceProblem);
      return;
    }
    const mutate = existing ? client.updateHeartbeat : client.createHeartbeat;
    if (!mutate) {
      setError(gt("Heartbeat editing isn't available here."));
      return;
    }
    const fields =
      schedule.kind === "cron"
        ? {
            scheduleKind: "cron" as const,
            cronExpression: schedule.cronExpression,
            timezone: schedule.timezone,
          }
        : { scheduleKind: "interval" as const, intervalMinutes: schedule.intervalMinutes };
    setSaving(true);
    setError(null);
    try {
      const saved = existing
        ? await client.updateHeartbeat!(existing.id, {
            name: name.trim(),
            ...fields,
            graceMinutes: graceNum,
          })
        : await client.createHeartbeat!({
            name: name.trim(),
            ...fields,
            graceMinutes: graceNum,
            ...(pickedSuggestion
              ? { resourceId: pickedSuggestion.resourceId, fieldKey: pickedSuggestion.fieldKey }
              : {}),
          });
      onSaved(saved);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : gt("Failed to save the heartbeat"));
    } finally {
      setSaving(false);
    }
  };

  const dismiss = () => {
    if (!saving) onClose();
  };

  const showSchedule = existing !== null || picked !== "";

  return (
    <Modal onClose={dismiss} ariaLabel={existing ? gt("Edit heartbeat") : gt("New heartbeat")}>
      <div className="w-[30rem] max-w-[90vw] rounded-2xl border border-border bg-surface p-5 shadow-xl">
        <h2 className="text-sm font-semibold text-on-surface">
          {existing ? gt("Edit heartbeat") : gt("New heartbeat")}
        </h2>

        <div className="mt-4 flex flex-col gap-3">
          {!existing && (
            <div>
              <label className={labelClass} htmlFor="heartbeat-source">
                {gt("Scheduled job")}
              </label>
              <select
                id="heartbeat-source"
                className={inputClass}
                value={picked}
                onChange={(e) => pick(e.target.value)}
                disabled={Boolean(seed)}
              >
                <option value="" disabled>
                  {suggestions === null
                    ? gt("Loading scheduled resources…")
                    : suggestions.length > 0
                      ? gt("Pick a scheduled resource…")
                      : gt("No scheduled resources found")}
                </option>
                {(suggestions ?? []).map((s) => (
                  <option key={suggestionKey(s)} value={suggestionKey(s)}>
                    {s.displayName} ({s.rawSchedule})
                  </option>
                ))}
                <option value={CUSTOM}>{gt("Custom schedule…")}</option>
              </select>
              {pickedSuggestion && pickedSuggestion.schedule === null && (
                <p className="mt-1 text-xs text-warning">
                  {gt(
                    "This schedule could not be read automatically. Rewrite it as five-field cron.",
                  )}
                </p>
              )}
              {pickedSuggestion && pickedSuggestion.watchedBy.length > 0 && (
                <p className="mt-1 text-xs text-on-surface-faint">
                  {gt("Already watched by another heartbeat.")}
                </p>
              )}
            </div>
          )}

          <div>
            <label className={labelClass} htmlFor="heartbeat-name">
              {gt("Name")}
            </label>
            <input
              id="heartbeat-name"
              type="text"
              maxLength={HEARTBEAT_LIMITS.maxNameLength}
              className={inputClass}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={gt("Nightly backup")}
            />
          </div>

          {showSchedule && (
            <>
              <fieldset>
                <legend className={labelClass}>{gt("Schedule")}</legend>
                <div className="flex gap-4 text-sm text-on-surface">
                  <label className="flex items-center gap-1.5">
                    <input
                      type="radio"
                      name="heartbeat-kind"
                      checked={kind === "cron"}
                      onChange={() => setKind("cron")}
                    />
                    {gt("Cron")}
                  </label>
                  <label className="flex items-center gap-1.5">
                    <input
                      type="radio"
                      name="heartbeat-kind"
                      checked={kind === "interval"}
                      onChange={() => setKind("interval")}
                    />
                    {gt("Fixed interval")}
                  </label>
                </div>
              </fieldset>

              {kind === "cron" ? (
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className={labelClass} htmlFor="heartbeat-cron">
                      {gt("Cron expression")}
                    </label>
                    <input
                      id="heartbeat-cron"
                      type="text"
                      className={`${inputClass} font-mono`}
                      value={cronExpression}
                      onChange={(e) => setCronExpression(e.target.value)}
                      placeholder="0 2 * * *"
                    />
                  </div>
                  <div>
                    <label className={labelClass} htmlFor="heartbeat-timezone">
                      {gt("Time zone")}
                    </label>
                    <input
                      id="heartbeat-timezone"
                      type="text"
                      list="heartbeat-timezones"
                      className={inputClass}
                      value={timezone}
                      onChange={(e) => setTimezone(e.target.value)}
                      placeholder="UTC"
                    />
                    <datalist id="heartbeat-timezones">
                      {zones.map((z) => (
                        <option key={z} value={z} />
                      ))}
                    </datalist>
                  </div>
                </div>
              ) : (
                <div>
                  <label className={labelClass} htmlFor="heartbeat-interval">
                    {gt("Interval (minutes)")}
                  </label>
                  <input
                    id="heartbeat-interval"
                    type="number"
                    min={HEARTBEAT_LIMITS.minIntervalMinutes}
                    max={HEARTBEAT_LIMITS.maxIntervalMinutes}
                    className={inputClass}
                    value={intervalMinutes}
                    onChange={(e) => setIntervalMinutes(e.target.value)}
                  />
                </div>
              )}
              {scheduleProblem !== null && <p className="text-xs text-danger">{scheduleProblem}</p>}
              {preview.length > 0 && (
                <p className="text-xs text-on-surface-faint">
                  {gt("Next runs: {times}", {
                    times: preview.map((d) => formatWhen(d.toISOString())).join(", "),
                  })}
                </p>
              )}

              <div>
                <label className={labelClass} htmlFor="heartbeat-grace">
                  {gt("Grace period (minutes)")}
                </label>
                <input
                  id="heartbeat-grace"
                  type="number"
                  min={HEARTBEAT_LIMITS.minGraceMinutes}
                  max={HEARTBEAT_LIMITS.maxGraceMinutes}
                  className={inputClass}
                  value={graceMinutes}
                  onChange={(e) => setGraceMinutes(e.target.value)}
                />
                {graceProblem !== null && (
                  <p className="mt-1 text-xs text-danger">{graceProblem}</p>
                )}
              </div>
            </>
          )}

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
            <button
              type="button"
              onClick={() => void save()}
              disabled={
                saving ||
                !showSchedule ||
                !name.trim() ||
                scheduleProblem !== null ||
                graceProblem !== null
              }
              className="rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-on-accent hover:bg-accent-hover disabled:opacity-50"
            >
              {saving ? gt("Saving…") : existing ? gt("Save changes") : gt("Create heartbeat")}
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
