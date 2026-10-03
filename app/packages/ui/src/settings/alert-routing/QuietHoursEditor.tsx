import { useGT } from "gt-react";
import {
  SEVERITY_LABELS,
  type AlertSeverity,
  type EscalationPolicy,
  type QuietHours,
} from "@infrawrench/client-core";
import { useDataString } from "../../i18n/data-strings.js";

import { INPUT, minutesToTime, timeToMinutes, WEEKDAY_ISOS, useWeekdayLabels } from "./shared.js";
import { DestinationPicker, type DestinationCatalog } from "./DestinationPicker.js";

/* -------------------------------------------------------------------------- */
/* Quiet hours and escalation                                                 */
/* -------------------------------------------------------------------------- */

export function QuietHoursEditor({
  value,
  onChange,
}: {
  value: QuietHours;
  onChange: (next: QuietHours) => void;
}) {
  const gt = useGT();
  const gtData = useDataString();
  const weekdayLabels = useWeekdayLabels();
  const wraps = value.endMinute < value.startMinute;
  return (
    <div className="space-y-2 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-on-surface-tertiary">{gt("Hold alerts between")}</span>
        <input
          className={INPUT}
          type="time"
          aria-label={gt("Quiet hours start")}
          value={minutesToTime(value.startMinute)}
          onChange={(e) => onChange({ ...value, startMinute: timeToMinutes(e.target.value) })}
        />
        <span className="text-on-surface-tertiary">{gt("and")}</span>
        <input
          className={INPUT}
          type="time"
          aria-label={gt("Quiet hours end")}
          value={minutesToTime(value.endMinute)}
          onChange={(e) => onChange({ ...value, endMinute: timeToMinutes(e.target.value) })}
        />
        {/* The placeholder is an example of the format, not the label — it
            disappears the moment anything is typed. */}
        <input
          className={`${INPUT} w-52`}
          aria-label={gt("Quiet hours timezone")}
          value={value.timezone}
          // i18n-ignore: IANA timezone identifier
          placeholder="Europe/Berlin"
          onChange={(e) => onChange({ ...value, timezone: e.target.value.trim() })}
        />
        {wraps && <span className="text-xs text-on-surface-faint">{gt("(overnight)")}</span>}
      </div>

      <div
        role="group"
        aria-label={gt("Days the quiet-hours window applies on")}
        className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-on-surface-tertiary"
      >
        <span>{gt("On")}</span>
        {WEEKDAY_ISOS.map((iso) => (
          <label key={iso} className="flex items-center gap-1.5">
            <input
              type="checkbox"
              checked={value.days.length === 0 || value.days.includes(iso)}
              onChange={(e) => {
                // An empty list means "every day"; the first time somebody
                // unticks a day it has to become an explicit six-day list
                // rather than a five-item one, or unticking Saturday would
                // silently also untick everything else.
                const base = value.days.length === 0 ? [...WEEKDAY_ISOS] : value.days;
                const next = e.target.checked
                  ? [...new Set([...base, iso])].sort()
                  : base.filter((x) => x !== iso);
                onChange({ ...value, days: next.length === 7 ? [] : next });
              }}
            />
            <span>{weekdayLabels[iso]}</span>
          </label>
        ))}
        {value.days.length === 0 && (
          <span className="text-on-surface-faint">{gt("(every day)")}</span>
        )}
      </div>

      <label className="flex flex-wrap items-center gap-2 text-xs text-on-surface-tertiary">
        <span>{gt("Send anyway when severity is at least")}</span>
        <select
          className={INPUT}
          value={value.urgentOverride ?? ""}
          onChange={(e) =>
            onChange({
              ...value,
              urgentOverride: e.target.value ? (e.target.value as AlertSeverity) : null,
            })
          }
        >
          <option value="">{gt("never — hold everything")}</option>
          {(Object.keys(SEVERITY_LABELS) as AlertSeverity[]).map((s) => (
            <option key={s} value={s}>
              {gtData(SEVERITY_LABELS[s])}
            </option>
          ))}
        </select>
      </label>

      <p className="text-xs text-on-surface-faint">
        {gt("Held alerts are queued, not dropped — they arrive when the window closes.")}
      </p>
    </div>
  );
}

export function EscalationEditor({
  value,
  catalog,
  onChange,
}: {
  value: EscalationPolicy;
  catalog: DestinationCatalog;
  onChange: (next: EscalationPolicy) => void;
}) {
  const gt = useGT();
  return (
    <div className="space-y-2 text-sm">
      <label className="flex flex-wrap items-center gap-2">
        <span className="text-on-surface-tertiary">{gt("If nobody acknowledges within")}</span>
        <input
          className={`${INPUT} w-20`}
          type="number"
          min={1}
          aria-label={gt("Minutes to wait before escalating")}
          value={value.afterMinutes}
          onChange={(e) => onChange({ ...value, afterMinutes: Number(e.target.value) || 1 })}
        />
        <span className="text-on-surface-tertiary">{gt("minutes, also notify:")}</span>
      </label>
      <DestinationPicker
        value={value.destinations}
        catalog={catalog}
        onChange={(destinations) => onChange({ ...value, destinations })}
        emptyLabel={gt("Connect a Slack or Teams channel to escalate to.")}
      />
      <p className="text-xs text-on-surface-faint">
        {gt(
          "Acknowledge from the button on the Slack message. Alerts sent only to Teams or push have no way to be acknowledged, so they will always escalate.",
        )}
      </p>
    </div>
  );
}
