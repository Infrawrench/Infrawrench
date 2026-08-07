/**
 * The alert routing rules editor.
 *
 * Replaces the trigger matrix that used to sit on every Slack channel and Teams
 * webhook row. That matrix could only answer "does this channel take this kind
 * of alert"; a rule answers "which alerts, under what conditions, to whom, when,
 * and what if nobody responds".
 *
 * Shape notes worth keeping in mind while reading:
 *
 * - The list is **ordered and first-match-wins** unless a rule says otherwise,
 *   so the editor always shows the position and the "stop here" state. That is
 *   what makes "anomalies over $500 on prod → #incidents, everything else →
 *   #infra-noise" two rules rather than one rule with an else-branch.
 * - Edits are held locally and saved as a whole list. Order is part of the
 *   meaning, so a half-applied reorder is a wrong routing table, not a
 *   momentarily stale one.
 * - An org with no rules is shown its synthesized default plus a note saying so,
 *   which keeps "connect Slack, get alerts" true without pretending the org has
 *   written anything. Editing it is what turns it into a real rule — the client
 *   -side `default` id is dropped on save and the server mints one — so the
 *   "Start from the default" button is a shortcut rather than a gate.
 */
import { useEffect, useMemo, useState } from "react";
import {
  ALERT_TRIGGERS,
  SEVERITY_LABELS,
  alertTriggerDef,
  validateAlertRule,
  type AlertCondition,
  type AlertDestination,
  type AlertRule,
  type AlertRulesResponse,
  type AlertSeverity,
  type AlertTrigger,
  type EscalationPolicy,
  type QuietHours,
} from "@infrawrench/client-core";

import { useSettingsHost } from "./host.js";

/* -------------------------------------------------------------------------- */
/* Small shared bits                                                          */
/* -------------------------------------------------------------------------- */

const INPUT =
  "rounded-md border border-border bg-surface px-2 py-1 text-sm text-on-surface-secondary";

function minutesToTime(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function timeToMinutes(value: string): number {
  const [h, m] = value.split(":").map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return 0;
  return Math.min(1439, Math.max(0, (h ?? 0) * 60 + (m ?? 0)));
}

/**
 * The browser's own zone as the default for a new quiet-hours window. Almost
 * always what the person filling in the form means, and a wrong guess is
 * visible in the field rather than hidden in a default nobody sees.
 */
function localTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

const WEEKDAYS = [
  { iso: 1, label: "Mon" },
  { iso: 2, label: "Tue" },
  { iso: 3, label: "Wed" },
  { iso: 4, label: "Thu" },
  { iso: 5, label: "Fri" },
  { iso: 6, label: "Sat" },
  { iso: 7, label: "Sun" },
];

/* -------------------------------------------------------------------------- */
/* Destinations                                                               */
/* -------------------------------------------------------------------------- */

interface DestinationCatalog {
  slackChannels: AlertRulesResponse["slackChannels"];
  msTeamsWebhooks: AlertRulesResponse["msTeamsWebhooks"];
}

function destinationLabel(d: AlertDestination, catalog: DestinationCatalog): string {
  switch (d.kind) {
    case "push":
      return "Mobile push";
    case "slack": {
      const ch = catalog.slackChannels.find((c) => c.id === d.channelId);
      return ch ? `#${ch.name}` : "#(removed channel)";
    }
    case "msteams": {
      const hook = catalog.msTeamsWebhooks.find((w) => w.id === d.webhookId);
      return hook ? hook.label : "(removed Teams channel)";
    }
  }
}

function DestinationPicker({
  value,
  catalog,
  onChange,
  emptyLabel,
}: {
  value: AlertDestination[];
  catalog: DestinationCatalog;
  onChange: (next: AlertDestination[]) => void;
  emptyLabel: string;
}) {
  const has = (d: AlertDestination): boolean =>
    value.some((v) =>
      v.kind !== d.kind
        ? false
        : v.kind === "push"
          ? true
          : v.kind === "slack" && d.kind === "slack"
            ? v.channelId === d.channelId
            : v.kind === "msteams" && d.kind === "msteams"
              ? v.webhookId === d.webhookId
              : false,
    );

  function toggle(d: AlertDestination, on: boolean): void {
    onChange(on ? [...value, d] : value.filter((v) => !sameDestination(v, d)));
  }

  const options: AlertDestination[] = [
    { kind: "push" },
    ...catalog.slackChannels.map((c): AlertDestination => ({ kind: "slack", channelId: c.id })),
    ...catalog.msTeamsWebhooks.map((w): AlertDestination => ({ kind: "msteams", webhookId: w.id })),
  ];

  if (options.length === 1) {
    return <p className="text-xs text-on-surface-faint">{emptyLabel}</p>;
  }

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-on-surface-tertiary">
      {options.map((d) => (
        <label key={destKey(d)} className="flex items-center gap-1.5 whitespace-nowrap">
          <input type="checkbox" checked={has(d)} onChange={(e) => toggle(d, e.target.checked)} />
          <span>{destinationLabel(d, catalog)}</span>
        </label>
      ))}
    </div>
  );
}

function destKey(d: AlertDestination): string {
  return d.kind === "push"
    ? "push"
    : d.kind === "slack"
      ? `slack:${d.channelId}`
      : `teams:${d.webhookId}`;
}

function sameDestination(a: AlertDestination, b: AlertDestination): boolean {
  return destKey(a) === destKey(b);
}

/* -------------------------------------------------------------------------- */
/* Conditions                                                                 */
/* -------------------------------------------------------------------------- */

function newCondition(field: AlertCondition["field"]): AlertCondition {
  switch (field) {
    case "trigger":
      return { field: "trigger", op: "in", values: [] };
    case "severity":
      return { field: "severity", op: "gte", severity: "warning" };
    case "accountId":
      return { field: "accountId", op: "in", values: [] };
    case "pluginId":
      return { field: "pluginId", op: "in", values: [] };
    case "resourceTypeId":
      return { field: "resourceTypeId", op: "in", values: [] };
    case "amountCents":
      return { field: "amountCents", op: "gte", cents: 50_000 };
    case "key":
      return { field: "key", op: "contains", value: "" };
    case "text":
      return { field: "text", op: "contains", value: "" };
  }
}

const CONDITION_LABELS: Record<AlertCondition["field"], string> = {
  trigger: "Trigger",
  severity: "Severity",
  accountId: "Account",
  pluginId: "Provider",
  resourceTypeId: "Resource type",
  amountCents: "Amount",
  key: "Name",
  text: "Message text",
};

function ConditionRow({
  condition,
  data,
  onChange,
  onRemove,
}: {
  condition: AlertCondition;
  data: AlertRulesResponse;
  onChange: (next: AlertCondition) => void;
  onRemove: () => void;
}) {
  const providers = useMemo(
    () => [...new Set(data.accounts.map((a) => a.pluginId))].sort(),
    [data.accounts],
  );

  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <span className="text-on-surface-tertiary w-28 shrink-0">
        {CONDITION_LABELS[condition.field]}
      </span>

      {condition.field === "severity" ? (
        <>
          <select
            className={INPUT}
            value={condition.op}
            onChange={(e) => onChange({ ...condition, op: e.target.value as "gte" | "eq" })}
          >
            <option value="gte">at least</option>
            <option value="eq">exactly</option>
          </select>
          <select
            className={INPUT}
            value={condition.severity}
            onChange={(e) => onChange({ ...condition, severity: e.target.value as AlertSeverity })}
          >
            {(Object.keys(SEVERITY_LABELS) as AlertSeverity[]).map((s) => (
              <option key={s} value={s}>
                {SEVERITY_LABELS[s]}
              </option>
            ))}
          </select>
        </>
      ) : condition.field === "amountCents" ? (
        <>
          <select
            className={INPUT}
            value={condition.op}
            onChange={(e) => onChange({ ...condition, op: e.target.value as "gte" | "lt" })}
          >
            <option value="gte">at least</option>
            <option value="lt">under</option>
          </select>
          <span className="text-on-surface-faint">$</span>
          <input
            className={`${INPUT} w-28`}
            type="number"
            min={0}
            step="0.01"
            value={(condition.cents / 100).toString()}
            onChange={(e) =>
              onChange({ ...condition, cents: Math.round(Number(e.target.value) * 100) || 0 })
            }
          />
        </>
      ) : condition.field === "key" || condition.field === "text" ? (
        <>
          <select
            className={INPUT}
            value={condition.op}
            onChange={(e) => {
              // Narrowed per field rather than shared: `key` also accepts an
              // exact match and `text` does not, so a single cast across both
              // would let the editor build a `text`/`eq` condition the matcher
              // has no case for.
              const op = e.target.value;
              onChange(
                condition.field === "key"
                  ? { ...condition, op: op as "contains" | "notContains" | "eq" }
                  : { ...condition, op: op as "contains" | "notContains" },
              );
            }}
          >
            <option value="contains">contains</option>
            <option value="notContains">does not contain</option>
            {condition.field === "key" && <option value="eq">is exactly</option>}
          </select>
          <input
            className={`${INPUT} flex-1 min-w-40`}
            value={condition.value}
            placeholder={condition.field === "key" ? "service or rule name" : "text in the alert"}
            onChange={(e) => onChange({ ...condition, value: e.target.value })}
          />
        </>
      ) : (
        <>
          <select
            className={INPUT}
            value={condition.op}
            onChange={(e) => onChange({ ...condition, op: e.target.value as "in" | "notIn" })}
          >
            <option value="in">is one of</option>
            <option value="notIn">is not one of</option>
          </select>
          <MultiSelect
            values={condition.values}
            options={
              condition.field === "trigger"
                ? ALERT_TRIGGERS.map((t) => ({ value: t.id as string, label: t.label }))
                : condition.field === "accountId"
                  ? data.accounts.map((a) => ({ value: a.id, label: a.displayName }))
                  : condition.field === "pluginId"
                    ? providers.map((p) => ({ value: p, label: p }))
                    : []
            }
            freeText={condition.field === "resourceTypeId"}
            onChange={(values) => onChange({ ...condition, values })}
          />
        </>
      )}

      <button
        type="button"
        onClick={onRemove}
        className="ml-auto text-xs text-red-400 hover:text-red-500 dark:text-red-300"
      >
        Remove
      </button>
    </div>
  );
}

/**
 * A checkbox list for the enumerable fields, and a comma-separated text input
 * for resource type ids — there are hundreds of those across 48 plugins, and a
 * picker over all of them is worse than typing the one you mean.
 */
function MultiSelect({
  values,
  options,
  freeText,
  onChange,
}: {
  values: string[];
  options: Array<{ value: string; label: string }>;
  freeText?: boolean;
  onChange: (next: string[]) => void;
}) {
  if (freeText || options.length === 0) {
    return (
      <input
        className={`${INPUT} flex-1 min-w-40`}
        value={values.join(", ")}
        placeholder="comma-separated ids"
        onChange={(e) =>
          onChange(
            e.target.value
              .split(",")
              .map((v) => v.trim())
              .filter(Boolean),
          )
        }
      />
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-on-surface-tertiary">
      {options.map((o) => (
        <label key={o.value} className="flex items-center gap-1.5 whitespace-nowrap">
          <input
            type="checkbox"
            checked={values.includes(o.value)}
            onChange={(e) =>
              onChange(
                e.target.checked ? [...values, o.value] : values.filter((v) => v !== o.value),
              )
            }
          />
          <span>{o.label}</span>
        </label>
      ))}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Quiet hours and escalation                                                 */
/* -------------------------------------------------------------------------- */

function QuietHoursEditor({
  value,
  onChange,
}: {
  value: QuietHours;
  onChange: (next: QuietHours) => void;
}) {
  const wraps = value.endMinute < value.startMinute;
  return (
    <div className="space-y-2 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-on-surface-tertiary">Hold alerts between</span>
        <input
          className={INPUT}
          type="time"
          value={minutesToTime(value.startMinute)}
          onChange={(e) => onChange({ ...value, startMinute: timeToMinutes(e.target.value) })}
        />
        <span className="text-on-surface-tertiary">and</span>
        <input
          className={INPUT}
          type="time"
          value={minutesToTime(value.endMinute)}
          onChange={(e) => onChange({ ...value, endMinute: timeToMinutes(e.target.value) })}
        />
        <input
          className={`${INPUT} w-52`}
          value={value.timezone}
          placeholder="Europe/Berlin"
          onChange={(e) => onChange({ ...value, timezone: e.target.value.trim() })}
        />
        {wraps && <span className="text-xs text-on-surface-faint">(overnight)</span>}
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-on-surface-tertiary">
        <span>On</span>
        {WEEKDAYS.map((d) => (
          <label key={d.iso} className="flex items-center gap-1.5">
            <input
              type="checkbox"
              checked={value.days.length === 0 || value.days.includes(d.iso)}
              onChange={(e) => {
                // An empty list means "every day"; the first time somebody
                // unticks a day it has to become an explicit six-day list
                // rather than a five-item one, or unticking Saturday would
                // silently also untick everything else.
                const base = value.days.length === 0 ? WEEKDAYS.map((w) => w.iso) : value.days;
                const next = e.target.checked
                  ? [...new Set([...base, d.iso])].sort()
                  : base.filter((x) => x !== d.iso);
                onChange({ ...value, days: next.length === 7 ? [] : next });
              }}
            />
            <span>{d.label}</span>
          </label>
        ))}
        {value.days.length === 0 && <span className="text-on-surface-faint">(every day)</span>}
      </div>

      <label className="flex flex-wrap items-center gap-2 text-xs text-on-surface-tertiary">
        <span>Send anyway when severity is at least</span>
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
          <option value="">never — hold everything</option>
          {(Object.keys(SEVERITY_LABELS) as AlertSeverity[]).map((s) => (
            <option key={s} value={s}>
              {SEVERITY_LABELS[s]}
            </option>
          ))}
        </select>
      </label>

      <p className="text-xs text-on-surface-faint">
        Held alerts are queued, not dropped — they arrive when the window closes.
      </p>
    </div>
  );
}

function EscalationEditor({
  value,
  catalog,
  onChange,
}: {
  value: EscalationPolicy;
  catalog: DestinationCatalog;
  onChange: (next: EscalationPolicy) => void;
}) {
  return (
    <div className="space-y-2 text-sm">
      <label className="flex flex-wrap items-center gap-2">
        <span className="text-on-surface-tertiary">If nobody acknowledges within</span>
        <input
          className={`${INPUT} w-20`}
          type="number"
          min={1}
          value={value.afterMinutes}
          onChange={(e) => onChange({ ...value, afterMinutes: Number(e.target.value) || 1 })}
        />
        <span className="text-on-surface-tertiary">minutes, also notify:</span>
      </label>
      <DestinationPicker
        value={value.destinations}
        catalog={catalog}
        onChange={(destinations) => onChange({ ...value, destinations })}
        emptyLabel="Connect a Slack or Teams channel to escalate to."
      />
      <p className="text-xs text-on-surface-faint">
        Acknowledge from the button on the Slack message. Alerts sent only to Teams or push have no
        way to be acknowledged, so they will always escalate.
      </p>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* One rule                                                                   */
/* -------------------------------------------------------------------------- */

function RuleCard({
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
  const [addField, setAddField] = useState<AlertCondition["field"]>("trigger");
  const problem = validateAlertRule(rule);

  return (
    <li className="border border-border rounded-lg p-4 space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-on-surface-faint w-6 shrink-0">{index + 1}</span>
        <input
          className={`${INPUT} flex-1 min-w-48 font-medium`}
          value={rule.name}
          placeholder="Rule name"
          onChange={(e) => onChange({ ...rule, name: e.target.value })}
        />
        <label className="flex items-center gap-1.5 text-xs text-on-surface-tertiary">
          <input
            type="checkbox"
            checked={rule.enabled}
            onChange={(e) => onChange({ ...rule, enabled: e.target.checked })}
          />
          <span>Enabled</span>
        </label>
        <div className="flex items-center gap-1">
          <button
            type="button"
            disabled={index === 0}
            onClick={() => onMove(-1)}
            className="px-1.5 text-xs text-on-surface-tertiary disabled:opacity-30"
            aria-label="Move up"
          >
            ↑
          </button>
          <button
            type="button"
            disabled={index === total - 1}
            onClick={() => onMove(1)}
            className="px-1.5 text-xs text-on-surface-tertiary disabled:opacity-30"
            aria-label="Move down"
          >
            ↓
          </button>
        </div>
        <button
          type="button"
          onClick={onRemove}
          className="text-xs text-red-400 hover:text-red-500 dark:text-red-300"
        >
          Delete
        </button>
      </div>

      <div className="space-y-2">
        <p className="text-xs font-semibold text-on-surface-tertiary uppercase tracking-wide">
          When
        </p>
        {rule.conditions.length === 0 ? (
          <p className="text-xs text-on-surface-faint">
            No conditions — this rule matches every alert.
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
            value={addField}
            onChange={(e) => setAddField(e.target.value as AlertCondition["field"])}
          >
            {(Object.keys(CONDITION_LABELS) as Array<AlertCondition["field"]>).map((f) => (
              <option key={f} value={f}>
                {CONDITION_LABELS[f]}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() =>
              onChange({ ...rule, conditions: [...rule.conditions, newCondition(addField)] })
            }
            className="text-xs text-blue-400 hover:text-blue-500 dark:text-blue-300"
          >
            Add condition
          </button>
          <span className="text-xs text-on-surface-faint">all conditions must match</span>
        </div>
      </div>

      <div className="space-y-2">
        <p className="text-xs font-semibold text-on-surface-tertiary uppercase tracking-wide">
          Send to
        </p>
        <DestinationPicker
          value={rule.destinations}
          catalog={data}
          onChange={(destinations) => onChange({ ...rule, destinations })}
          emptyLabel="Connect a Slack or Teams channel below to route alerts to it."
        />
        {rule.destinations.length === 0 && (
          <p className="text-xs text-amber-500">
            No destinations — this rule swallows matching alerts and stops the rules below it from
            seeing them.
          </p>
        )}
      </div>

      <label className="flex items-center gap-2 text-xs text-on-surface-tertiary">
        <input
          type="checkbox"
          checked={!rule.continueOnMatch}
          onChange={(e) => onChange({ ...rule, continueOnMatch: !e.target.checked })}
        />
        <span>Stop here — don&apos;t evaluate the rules below this one</span>
      </label>

      <details className="text-sm">
        <summary className="cursor-pointer text-xs text-on-surface-tertiary">
          Quiet hours {rule.quietHours ? "· on" : "· off"}
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
            <span>Hold matching alerts during a window</span>
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
          Escalation {rule.escalation ? `· after ${rule.escalation.afterMinutes} min` : "· off"}
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
            <span>Escalate if nobody acknowledges</span>
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

      {problem && <p className="text-xs text-red-400">{problem}</p>}
    </li>
  );
}

/* -------------------------------------------------------------------------- */
/* The section                                                                */
/* -------------------------------------------------------------------------- */

let nextLocalId = 0;

/**
 * Whether an id came from the server rather than from this editor.
 *
 * `blankRule` mints `new-N` so React keys and the destination pickers are
 * stable before the first save, and the synthesized default carries `default`.
 * Neither exists in the table, and the API rejects an id it does not recognise.
 */
function isPersistedRuleId(id: string): boolean {
  return id !== "default" && !id.startsWith("new-");
}

function blankRule(position: number): AlertRule {
  nextLocalId += 1;
  return {
    // A client-side id so React keys and the destination pickers are stable
    // before the first save; the server keeps whatever id it is sent.
    id: `new-${nextLocalId}`,
    name: "",
    enabled: true,
    position,
    conditions: [{ field: "trigger", op: "in", values: [] }],
    destinations: [],
    continueOnMatch: false,
    quietHours: null,
    escalation: null,
  };
}

export function AlertRoutingSection({ orgId }: { orgId: string }) {
  const { api } = useSettingsHost();
  const [data, setData] = useState<AlertRulesResponse | null>(null);
  const [rules, setRules] = useState<AlertRule[]>([]);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [reloadNonce, setReloadNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await api.get<AlertRulesResponse>(`/api/org/${orgId}/alert-rules`);
        if (cancelled) return;
        setData(res);
        setRules(res.rules);
        setDirty(false);
      } catch {
        // Non-admins get a 403 — hide the section rather than show an error,
        // matching how the drift and digest settings behave.
        if (!cancelled) setForbidden(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [orgId, reloadNonce]);

  function update(next: AlertRule[]): void {
    setRules(next);
    setDirty(true);
  }

  async function handleSave(): Promise<void> {
    setSaving(true);
    setError(null);
    try {
      // Client-side ids (`new-…` from `blankRule`, `default` from the
      // synthesized rule) never existed on the server, so they are dropped and
      // the server mints real ones. Ids that came *from* the server are sent
      // back, which is what keeps in-flight held and escalating deliveries
      // attributed to the rule that made them across an unrelated edit.
      const payload = rules.map(({ id, ...rest }) =>
        isPersistedRuleId(id) ? { id, ...rest } : rest,
      );
      const res = await api.put<{ rules: AlertRule[] }>(`/api/org/${orgId}/alert-rules`, {
        rules: payload,
      });
      setRules(res.rules);
      setDirty(false);
      setReloadNonce((n) => n + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save rules");
    } finally {
      setSaving(false);
    }
  }

  async function handleAdopt(): Promise<void> {
    setSaving(true);
    setError(null);
    try {
      await api.post(`/api/org/${orgId}/alert-rules/adopt-defaults`);
      setReloadNonce((n) => n + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save rules");
    } finally {
      setSaving(false);
    }
  }

  if (forbidden || !data) return null;

  const firstProblem = rules.map(validateAlertRule).find(Boolean) ?? null;

  return (
    <section className="border border-border rounded-xl p-5 space-y-4">
      <div>
        <h2 className="text-sm font-semibold text-on-surface-secondary">Alert routing</h2>
        <p className="text-xs text-on-surface-muted mt-1">
          Rules are evaluated top to bottom. The first rule that matches decides where an alert
          goes, unless it says to keep going — so put the specific rules above the general ones.
        </p>
      </div>

      {data.usingDefaults && !dirty && (
        <div className="rounded-lg border border-border/60 bg-surface-muted/40 p-3 space-y-2">
          <p className="text-xs text-on-surface-secondary">
            You haven&apos;t written any rules, so alerts follow the default: everything except
            drift goes to every connected channel and to mobile push.
          </p>
          <button
            type="button"
            onClick={() => void handleAdopt()}
            disabled={saving}
            className="text-xs text-blue-400 hover:text-blue-500 dark:text-blue-300 disabled:opacity-50"
          >
            Start from the default and edit it
          </button>
        </div>
      )}

      {rules.length > 0 && (
        <ul className="space-y-3">
          {rules.map((rule, i) => (
            <RuleCard
              key={rule.id}
              rule={rule}
              index={i}
              total={rules.length}
              data={data}
              onChange={(next) => update(rules.map((r, j) => (j === i ? next : r)))}
              onRemove={() => update(rules.filter((_, j) => j !== i))}
              onMove={(delta) => {
                const target = i + delta;
                if (target < 0 || target >= rules.length) return;
                const next = [...rules];
                const [moved] = next.splice(i, 1);
                if (moved) next.splice(target, 0, moved);
                update(next);
              }}
            />
          ))}
        </ul>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => update([...rules, blankRule(rules.length)])}
          className="text-xs text-blue-400 hover:text-blue-500 dark:text-blue-300"
        >
          Add rule
        </button>
        {dirty && (
          <>
            <button
              type="button"
              onClick={() => void handleSave()}
              disabled={saving || firstProblem !== null}
              className="rounded-md bg-blue-600 px-3 py-1.5 text-xs text-white disabled:opacity-50"
            >
              {saving ? "Saving…" : "Save rules"}
            </button>
            <button
              type="button"
              onClick={() => setReloadNonce((n) => n + 1)}
              disabled={saving}
              className="text-xs text-on-surface-tertiary hover:text-on-surface-secondary"
            >
              Discard changes
            </button>
          </>
        )}
      </div>

      {error && <p className="text-xs text-red-400">{error}</p>}

      <AlertDeliveriesPanel orgId={orgId} />
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* Recent deliveries                                                          */
/* -------------------------------------------------------------------------- */

interface DeliveryRow {
  id: string;
  trigger: AlertTrigger;
  severity: AlertSeverity;
  title: string;
  ruleName: string | null;
  state: string;
  createdAt: string;
  deliverAfter: string | null;
  escalateAt: string | null;
}

const STATE_LABELS: Record<string, string> = {
  held: "Held for quiet hours",
  awaiting_ack: "Waiting for acknowledgement",
  sent: "Sent",
  acknowledged: "Acknowledged",
  escalated: "Escalated",
  expired: "Given up",
};

/**
 * What the rules actually did. Only ever shows rows a rule created follow-up
 * work for — an alert that went straight out with no quiet hours and no
 * escalation leaves no row, which keeps this list about the things somebody may
 * still need to act on.
 */
function AlertDeliveriesPanel({ orgId }: { orgId: string }) {
  const { api } = useSettingsHost();
  const [rows, setRows] = useState<DeliveryRow[] | null>(null);

  useEffect(() => {
    api
      .get<DeliveryRow[]>(`/api/org/${orgId}/alert-rules/deliveries?limit=20`)
      .then(setRows)
      .catch(() => setRows([]));
  }, [orgId]);

  if (!rows || rows.length === 0) return null;

  return (
    <div className="pt-3 border-t border-border/50 space-y-2">
      <h3 className="text-xs font-semibold text-on-surface-tertiary uppercase tracking-wide">
        Recent held and escalating alerts
      </h3>
      <ul className="divide-y divide-border/50">
        {rows.map((r) => (
          <li key={r.id} className="py-2 text-sm">
            <p className="text-on-surface-secondary truncate">{r.title}</p>
            <p className="text-xs text-on-surface-tertiary">
              {alertTriggerDef(r.trigger).label} · {STATE_LABELS[r.state] ?? r.state}
              {r.ruleName ? ` · ${r.ruleName}` : ""}
              {r.state === "held" && r.deliverAfter
                ? ` · sends ${new Date(r.deliverAfter).toLocaleString()}`
                : ""}
              {r.state === "awaiting_ack" && r.escalateAt
                ? ` · escalates ${new Date(r.escalateAt).toLocaleString()}`
                : ""}
            </p>
          </li>
        ))}
      </ul>
    </div>
  );
}
