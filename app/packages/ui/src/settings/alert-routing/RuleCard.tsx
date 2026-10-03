import { useState } from "react";
import { useGT } from "gt-react";
import {
  validateAlertRule,
  type AlertCondition,
  type AlertRule,
  type AlertRulesResponse,
} from "@infrawrench/client-core";

import { INPUT, localTimezone } from "./shared.js";
import { DestinationPicker } from "./DestinationPicker.js";
import {
  newCondition,
  CONDITION_FIELDS,
  useConditionLabels,
  ConditionRow,
} from "./ConditionRow.js";
import { QuietHoursEditor, EscalationEditor } from "./QuietHoursEditor.js";

/* -------------------------------------------------------------------------- */
/* One rule                                                                   */
/* -------------------------------------------------------------------------- */

export function RuleCard({
  rule,
  index,
  total,
  data,
  onChange,
  onRemove,
  onMove,
}: {
  rule: AlertRule;
  index: number;
  total: number;
  data: AlertRulesResponse;
  onChange: (next: AlertRule) => void;
  onRemove: () => void;
  onMove: (delta: number) => void;
}) {
  const gt = useGT();
  const conditionLabels = useConditionLabels();
  const [addField, setAddField] = useState<AlertCondition["field"]>("trigger");
  const problem = validateAlertRule(rule);

  return (
    <li className="border border-border rounded-lg p-4 space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-on-surface-faint w-6 shrink-0">{index + 1}</span>
        <input
          className={`${INPUT} flex-1 min-w-48 font-medium`}
          aria-label={gt("Name of rule {n}", { n: index + 1 })}
          value={rule.name}
          placeholder={gt("Rule name")}
          onChange={(e) => onChange({ ...rule, name: e.target.value })}
        />
        <label className="flex items-center gap-1.5 text-xs text-on-surface-tertiary">
          <input
            type="checkbox"
            checked={rule.enabled}
            onChange={(e) => onChange({ ...rule, enabled: e.target.checked })}
          />
          <span>{gt("Enabled")}</span>
        </label>
        <div className="flex items-center gap-1">
          <button
            type="button"
            disabled={index === 0}
            onClick={() => onMove(-1)}
            className="px-1.5 text-xs text-on-surface-tertiary disabled:opacity-30"
            aria-label={gt("Move rule {n} up", { n: index + 1 })}
          >
            ↑
          </button>
          <button
            type="button"
            disabled={index === total - 1}
            onClick={() => onMove(1)}
            className="px-1.5 text-xs text-on-surface-tertiary disabled:opacity-30"
            aria-label={gt("Move rule {n} down", { n: index + 1 })}
          >
            ↓
          </button>
        </div>
        <button
          type="button"
          onClick={onRemove}
          aria-label={
            rule.name
              ? gt("Delete rule {n}, {name}", { n: index + 1, name: rule.name })
              : gt("Delete rule {n}", { n: index + 1 })
          }
          className="text-xs text-danger hover:text-danger-strong"
        >
          {gt("Delete")}
        </button>
      </div>

      <div className="space-y-2">
        <p className="text-xs font-semibold text-on-surface-tertiary uppercase tracking-wide">
          {gt("When")}
        </p>
        {rule.conditions.length === 0 ? (
          <p className="text-xs text-on-surface-faint">
            {gt("No conditions — this rule matches every alert.")}
          </p>
        ) : (
          rule.conditions.map((condition, i) => (
            <ConditionRow
              key={`${condition.field}-${i}`}
              condition={condition}
              data={data}
              onChange={(next) =>
                onChange({
                  ...rule,
                  conditions: rule.conditions.map((c, j) => (j === i ? next : c)),
                })
              }
              onRemove={() =>
                onChange({ ...rule, conditions: rule.conditions.filter((_, j) => j !== i) })
              }
            />
          ))
        )}
        <div className="flex items-center gap-2">
          <select
            className={INPUT}
            aria-label={gt("Condition to add")}
            value={addField}
            onChange={(e) => setAddField(e.target.value as AlertCondition["field"])}
          >
            {CONDITION_FIELDS.map((f) => (
              <option key={f} value={f}>
                {conditionLabels[f]}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() =>
              onChange({ ...rule, conditions: [...rule.conditions, newCondition(addField)] })
            }
            className="text-xs text-info hover:text-info-strong"
          >
            {gt("Add condition")}
          </button>
          <span className="text-xs text-on-surface-faint">{gt("all conditions must match")}</span>
        </div>
      </div>

      <div className="space-y-2">
        <p className="text-xs font-semibold text-on-surface-tertiary uppercase tracking-wide">
          {gt("Send to")}
        </p>
        <DestinationPicker
          value={rule.destinations}
          catalog={data}
          onChange={(destinations) => onChange({ ...rule, destinations })}
          emptyLabel={gt("Connect a Slack or Teams channel below to route alerts to it.")}
        />
        {rule.destinations.length === 0 && (
          <p className="text-xs text-warning">
            {gt(
              "No destinations — this rule swallows matching alerts and stops the rules below it from seeing them.",
            )}
          </p>
        )}
      </div>

      <label className="flex items-center gap-2 text-xs text-on-surface-tertiary">
        <input
          type="checkbox"
          checked={!rule.continueOnMatch}
          onChange={(e) => onChange({ ...rule, continueOnMatch: !e.target.checked })}
        />
        <span>{gt("Stop here — don't evaluate the rules below this one")}</span>
      </label>

      <details className="text-sm">
        <summary className="cursor-pointer text-xs text-on-surface-tertiary">
          {gt("Quiet hours {state}", {
            state: rule.quietHours ? gt("· on") : gt("· off"),
          })}
        </summary>
        <div className="mt-2 pl-3 border-l border-border/60">
          <label className="flex items-center gap-2 text-xs text-on-surface-tertiary mb-2">
            <input
              type="checkbox"
              checked={rule.quietHours !== null}
              onChange={(e) =>
                onChange({
                  ...rule,
                  quietHours: e.target.checked
                    ? {
                        timezone: localTimezone(),
                        startMinute: 22 * 60,
                        endMinute: 8 * 60,
                        days: [],
                        urgentOverride: "critical",
                      }
                    : null,
                })
              }
            />
            <span>{gt("Hold matching alerts during a window")}</span>
          </label>
          {rule.quietHours && (
            <QuietHoursEditor
              value={rule.quietHours}
              onChange={(quietHours) => onChange({ ...rule, quietHours })}
            />
          )}
        </div>
      </details>

      <details className="text-sm">
        <summary className="cursor-pointer text-xs text-on-surface-tertiary">
          {gt("Escalation {state}", {
            state: rule.escalation
              ? gt("· after {n} min", { n: rule.escalation.afterMinutes })
              : gt("· off"),
          })}
        </summary>
        <div className="mt-2 pl-3 border-l border-border/60">
          <label className="flex items-center gap-2 text-xs text-on-surface-tertiary mb-2">
            <input
              type="checkbox"
              checked={rule.escalation !== null}
              onChange={(e) =>
                onChange({
                  ...rule,
                  escalation: e.target.checked ? { afterMinutes: 15, destinations: [] } : null,
                })
              }
            />
            <span>{gt("Escalate if nobody acknowledges")}</span>
          </label>
          {rule.escalation && (
            <EscalationEditor
              value={rule.escalation}
              catalog={data}
              onChange={(escalation) => onChange({ ...rule, escalation })}
            />
          )}
        </div>
      </details>

      {problem && <p className="text-xs text-danger">{problem}</p>}
    </li>
  );
}
