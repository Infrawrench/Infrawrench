import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { T, Var, t, useGT } from "gt-react";
import {
  WEEKDAY_LABELS,
  formatMoney,
  hoursOffPerWeek,
  validateScheduleTiming,
  type SleepScheduleTiming,
} from "@infrawrench/client-core";
import { Modal } from "../components/Modal.js";
import { useDataString } from "../i18n/data-strings.js";
import type { SchedulePreview, SchedulesClient, SleepSchedule } from "./types.js";

const inputClass =
  "w-full rounded-lg border border-border bg-surface-sunken px-2.5 py-1.5 text-sm text-on-surface focus:outline-none focus:border-blue-500";
const labelClass = "block text-xs font-medium text-on-surface-secondary mb-1";

/** The resource the editor attaches a schedule to. */
export interface ScheduleEditorTarget {
  resourceId: string;
  accountId: string;
  resourceName: string;
}

export interface ScheduleEditorModalProps {
  client: SchedulesClient;
  target: ScheduleEditorTarget;
  /** Existing schedule to edit, or null to create one. */
  existing: SleepSchedule | null;
  onSaved: (schedule: SleepSchedule) => void;
  onClose: () => void;
}

const DEFAULT_TIMING: SleepScheduleTiming = {
  daysOfWeek: [1, 2, 3, 4, 5],
  stopTime: "19:00",
  startTime: "08:00",
  timezone: "UTC",
};

function hostTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/**
 * IANA zone list, when the runtime can enumerate it. `Intl.supportedValuesOf`
 * needs a lib newer than our ES2022 target, so it is feature-detected; the
 * fallback keeps the field editable as free text.
 */
function knownTimeZones(): string[] {
  const intl = Intl as unknown as { supportedValuesOf?: (key: string) => string[] };
  try {
    return intl.supportedValuesOf?.("timeZone") ?? [];
  } catch {
    return [];
  }
}

function formatTransition(at: string, action: string, timezone: string): string {
  try {
    const formatted = new Intl.DateTimeFormat(undefined, {
      timeZone: timezone,
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).format(new Date(at));
    const status = action === "stop" ? t("Off") : t("On");
    return t("{status} {date}", { status, date: formatted });
  } catch {
    const status = action === "stop" ? t("Off") : t("On");
    return t("{status} {date}", { status, date: at });
  }
}

/**
 * The no-code schedule editor: days of week, off/on times, timezone — and a
 * live projected-saving quote computed server-side from the resource's
 * trailing spend before anything is saved.
 */
export function ScheduleEditorModal({
  client,
  target,
  existing,
  onSaved,
  onClose,
}: ScheduleEditorModalProps) {
  const gt = useGT();
  const gtData = useDataString();
  const [timing, setTiming] = useState<SleepScheduleTiming>(() =>
    existing
      ? {
          daysOfWeek: existing.daysOfWeek,
          stopTime: existing.stopTime,
          startTime: existing.startTime,
          timezone: existing.timezone,
        }
      : { ...DEFAULT_TIMING, timezone: hostTimeZone() },
  );
  const [preview, setPreview] = useState<SchedulePreview | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const previewSeq = useRef(0);

  const zones = useMemo(knownTimeZones, []);
  const timingError = validateScheduleTiming(timing);

  const refreshPreview = useCallback(async () => {
    if (validateScheduleTiming(timing) !== null) {
      setPreview(null);
      return;
    }
    const seq = ++previewSeq.current;
    try {
      const next = await client.previewSchedule({
        resourceId: target.resourceId,
        accountId: target.accountId,
        ...timing,
      });
      if (seq === previewSeq.current) setPreview(next);
    } catch {
      // The quote is advisory; a failed preview never blocks the editor.
      if (seq === previewSeq.current) setPreview(null);
    }
  }, [client, target.resourceId, target.accountId, timing]);

  useEffect(() => {
    const handle = setTimeout(() => void refreshPreview(), 300);
    return () => clearTimeout(handle);
  }, [refreshPreview]);

  const toggleDay = (day: number) => {
    setTiming((prev) => {
      const has = prev.daysOfWeek.includes(day);
      const days = has ? prev.daysOfWeek.filter((d) => d !== day) : [...prev.daysOfWeek, day];
      days.sort((a, b) => a - b);
      return { ...prev, daysOfWeek: days };
    });
  };

  const save = async () => {
    const problem = validateScheduleTiming(timing);
    if (problem) {
      setError(problem);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const saved = existing
        ? await client.updateSchedule(existing.id, { ...timing })
        : await client.createSchedule({
            resourceId: target.resourceId,
            accountId: target.accountId,
            ...timing,
          });
      onSaved(saved);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : gt("Failed to save schedule"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      onClose={onClose}
      ariaLabel={existing ? gt("Edit sleep schedule") : gt("New sleep schedule")}
    >
      <div className="w-[28rem] max-w-[90vw] rounded-2xl border border-border bg-surface p-5 shadow-xl">
        <h2 className="text-sm font-semibold text-on-surface">
          {existing ? gt("Edit sleep schedule") : gt("New sleep schedule")}
        </h2>
        <T>
          <p className="mt-1 text-xs text-on-surface-secondary">
            <Var>{target.resourceName}</Var> is stopped at the off time and started at the on time
            on each selected day, in the chosen timezone (DST-safe). Weekends between selected days
            stay off.
          </p>
        </T>

        <div className="mt-4 flex flex-col gap-3">
          <div>
            <span className={labelClass}>{gt("Days of week")}</span>
            <div className="flex gap-1" role="group" aria-label={gt("Days of week")}>
              {WEEKDAY_LABELS.map((label, i) => {
                const day = i + 1;
                const active = timing.daysOfWeek.includes(day);
                return (
                  <button
                    key={label}
                    type="button"
                    aria-pressed={active}
                    onClick={() => toggleDay(day)}
                    className={`flex-1 rounded-lg border px-1 py-1.5 text-xs ${
                      active
                        ? "border-blue-500 bg-blue-500/15 text-on-surface"
                        : "border-border bg-surface-sunken text-on-surface-tertiary hover:border-border-strong"
                    }`}
                  >
                    {gtData(label)}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelClass} htmlFor="schedule-stop-time">
                {gt("Off at")}
              </label>
              <input
                id="schedule-stop-time"
                type="time"
                className={inputClass}
                value={timing.stopTime}
                onChange={(e) => setTiming((p) => ({ ...p, stopTime: e.target.value }))}
              />
            </div>
            <div>
              <label className={labelClass} htmlFor="schedule-start-time">
                {gt("On at")}
              </label>
              <input
                id="schedule-start-time"
                type="time"
                className={inputClass}
                value={timing.startTime}
                onChange={(e) => setTiming((p) => ({ ...p, startTime: e.target.value }))}
              />
            </div>
          </div>

          <div>
            <label className={labelClass} htmlFor="schedule-timezone">
              {gt("Timezone")}
            </label>
            {zones.length > 0 ? (
              <select
                id="schedule-timezone"
                className={inputClass}
                value={timing.timezone}
                onChange={(e) => setTiming((p) => ({ ...p, timezone: e.target.value }))}
              >
                {!zones.includes(timing.timezone) && (
                  <option value={timing.timezone}>{timing.timezone}</option>
                )}
                {zones.map((z) => (
                  <option key={z} value={z}>
                    {z}
                  </option>
                ))}
              </select>
            ) : (
              <input
                id="schedule-timezone"
                type="text"
                className={inputClass}
                value={timing.timezone}
                onChange={(e) => setTiming((p) => ({ ...p, timezone: e.target.value }))}
                placeholder={gt("Europe/London")}
              />
            )}
          </div>

          <div className="rounded-xl border border-border bg-surface-sunken px-3 py-2.5 text-xs text-on-surface-secondary">
            {timingError ? (
              <span>{timingError}</span>
            ) : (
              <>
                <div className="text-on-surface">
                  {gt("Off ~{hours}h per week", { hours: Math.round(hoursOffPerWeek(timing)) })}
                  {preview?.projectedMonthlySaving != null && preview.currency ? (
                    <T>
                      <>
                        {" · "}projected saving{" "}
                        <Var>
                          <span className="font-semibold">
                            {formatMoney(preview.projectedMonthlySaving, preview.currency)}/mo
                          </span>
                        </Var>
                      </>
                    </T>
                  ) : null}
                </div>
                {preview !== null && preview.projectedMonthlySaving == null && (
                  <T>
                    <div className="mt-1">
                      No per-resource billing rows for this resource yet, so there is no savings
                      figure — the schedule works either way.
                    </div>
                  </T>
                )}
                {preview && preview.nextTransitions.length > 0 && (
                  <T>
                    <div className="mt-1 text-on-surface-faint">
                      Next:{" "}
                      <Var>
                        {preview.nextTransitions
                          .slice(0, 3)
                          .map((t) => formatTransition(t.at, t.action, timing.timezone))
                          .join(" · ")}
                      </Var>
                    </div>
                  </T>
                )}
              </>
            )}
          </div>

          {error !== null && (
            <div role="alert" className="text-sm text-danger">
              {error}
            </div>
          )}

          <div className="mt-1 flex justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-border bg-surface-raised px-3 py-1.5 text-sm text-on-surface hover:border-border-strong"
            >
              {gt("Cancel")}
            </button>
            <button
              type="button"
              onClick={() => void save()}
              disabled={saving || timingError !== null}
              className="rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50"
            >
              {saving ? gt("Saving…") : existing ? gt("Save changes") : gt("Create schedule")}
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
