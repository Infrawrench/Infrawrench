import { useCallback, useEffect, useState } from "react";
import { useGT } from "gt-react";
import {
  DEFAULT_METRIC_ALERT_INPUT,
  describeMetricAlertCondition,
  describeMetricAlertSelector,
  type MetricAlertEvent,
  type MetricAlertRuleInput,
  type MetricAlertRuleWithStatus,
} from "./config.js";
import { MetricAlertRuleModal } from "./MetricAlertRuleModal.js";
import type { MetricAlertsClient } from "./types.js";

export interface MetricAlertsPanelProps {
  client: MetricAlertsClient;
  /**
   * Declare an incident from a firing, seeded with the rule name and the
   * resource. Optional: a host that has no incidents surface (or a caller
   * without `incidents:write`) simply omits it and the column disappears.
   *
   * This exists because a firing alert is one of the two places an incident
   * actually starts, and making somebody navigate elsewhere and retype what
   * they are looking at is how incidents end up declared in Slack instead.
   */
  onDeclareIncident?: (seed: {
    title: string;
    summary?: string;
    resourceIds?: string[];
    startedAt?: string;
  }) => void;
}

function formatWhen(iso: string): string {
  try {
    return new Date(iso).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

/**
 * Metric threshold alert rules: list, create, edit, delete, plus the recent
 * firing history. Shared between web and desktop; write actions are gated on
 * the client exposing the write methods (the `CostsPanel` convention).
 */
export function MetricAlertsPanel({ client, onDeclareIncident }: MetricAlertsPanelProps) {
  const gt = useGT();
  // null = loading, [] = loaded-empty.
  const [rules, setRules] = useState<MetricAlertRuleWithStatus[] | null>(null);
  const [events, setEvents] = useState<MetricAlertEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<{
    ruleId: string | null;
    initial: MetricAlertRuleInput;
  } | null>(null);

  const canWrite = Boolean(client.createRule && client.updateRule && client.deleteRule);

  const reload = useCallback(() => {
    client
      .listRules()
      .then(setRules)
      .catch((e) => setError(e instanceof Error ? e.message : "Failed to load rules"));
    client
      .listEvents({ limit: 50 })
      .then(setEvents)
      .catch(() => setEvents([]));
  }, [client]);

  useEffect(() => {
    reload();
  }, [reload]);

  const save = async (input: MetricAlertRuleInput) => {
    if (!editing) return;
    if (editing.ruleId === null) {
      await client.createRule?.(input);
    } else {
      await client.updateRule?.(editing.ruleId, input);
    }
    reload();
  };

  const toggle = async (rule: MetricAlertRuleWithStatus) => {
    await client.updateRule?.(rule.id, { ...ruleToInput(rule), enabled: !rule.enabled });
    reload();
  };

  const remove = async (rule: MetricAlertRuleWithStatus) => {
    if (!window.confirm(gt('Delete metric alert rule "{name}"?', { name: rule.name }))) return;
    await client.deleteRule?.(rule.id);
    reload();
  };

  return (
    <div className="space-y-6">
      <section>
        <div className="flex items-center justify-between mb-2">
          <div>
            <h2 className="text-base font-semibold text-on-surface">{gt("Metric alerts")}</h2>
            <p className="text-xs text-on-surface-faint">
              {gt(
                'Threshold rules over collected metrics — "CPU > 90% for 15 minutes". Rules select resources by query, so new resources are covered automatically.',
              )}
            </p>
          </div>
          {canWrite && (
            <button
              type="button"
              onClick={() => setEditing({ ruleId: null, initial: DEFAULT_METRIC_ALERT_INPUT })}
              className="px-3 py-1.5 rounded-lg text-sm bg-blue-600 hover:bg-blue-500 text-white transition-colors"
            >
              {gt("New rule")}
            </button>
          )}
        </div>

        {error && <p className="text-sm text-danger">{error}</p>}
        {rules === null && !error && (
          <p className="text-sm text-on-surface-faint">{gt("Loading rules…")}</p>
        )}
        {rules !== null && rules.length === 0 && (
          <p className="text-sm text-on-surface-faint">
            {gt("No rules yet. Create one to get paged when a metric crosses a threshold.")}
          </p>
        )}

        {rules !== null && rules.length > 0 && (
          <ul className="space-y-2">
            {rules.map((rule) => (
              <li
                key={rule.id}
                className="rounded-xl border border-border bg-surface-raised px-4 py-3 flex items-center gap-3"
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span
                      className={`inline-block h-2 w-2 rounded-full ${
                        rule.firingCount > 0
                          ? "bg-red-500"
                          : rule.enabled
                            ? "bg-emerald-500"
                            : "bg-neutral-500"
                      }`}
                      title={
                        rule.firingCount > 0
                          ? gt("Firing")
                          : rule.enabled
                            ? gt("Healthy")
                            : gt("Disabled")
                      }
                    />
                    <span className="text-sm font-medium text-on-surface truncate">
                      {rule.name}
                    </span>
                    {rule.firingCount > 0 && (
                      <span className="text-xs text-danger">
                        {gt("firing on {count} resource", { count: rule.firingCount })}
                        {rule.firingCount === 1 ? "" : gt("s")}
                      </span>
                    )}
                    {!rule.enabled && (
                      <span className="text-xs text-on-surface-faint">{gt("disabled")}</span>
                    )}
                  </div>
                  <p className="text-xs text-on-surface-secondary truncate">
                    {describeMetricAlertCondition(rule)} · {describeMetricAlertSelector(rule)} ·{" "}
                    {gt("matches {count} resource", { count: rule.matchingResourceCount })}
                    {rule.matchingResourceCount === 1 ? "" : gt("s")}
                  </p>
                </div>
                {canWrite && (
                  <div className="flex items-center gap-1.5 shrink-0">
                    <button
                      type="button"
                      onClick={() => void toggle(rule)}
                      className="px-2 py-1 rounded-lg text-xs text-on-surface-secondary hover:bg-surface-sunken transition-colors"
                    >
                      {rule.enabled ? gt("Disable") : gt("Enable")}
                    </button>
                    <button
                      type="button"
                      onClick={() => setEditing({ ruleId: rule.id, initial: ruleToInput(rule) })}
                      className="px-2 py-1 rounded-lg text-xs text-on-surface-secondary hover:bg-surface-sunken transition-colors"
                    >
                      {gt("Edit")}
                    </button>
                    <button
                      type="button"
                      onClick={() => void remove(rule)}
                      className="px-2 py-1 rounded-lg text-xs text-danger hover:bg-surface-sunken transition-colors"
                    >
                      {gt("Delete")}
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h3 className="text-sm font-semibold text-on-surface mb-2">{gt("Recent firings")}</h3>
        {events === null && <p className="text-sm text-on-surface-faint">{gt("Loading…")}</p>}
        {events !== null && events.length === 0 && (
          <p className="text-sm text-on-surface-faint">{gt("No firings yet.")}</p>
        )}
        {events !== null && events.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-on-surface-faint">
                  <th scope="col" className="py-1.5 pr-3 font-medium">
                    {gt("Rule")}
                  </th>
                  <th scope="col" className="py-1.5 pr-3 font-medium">
                    {gt("Resource")}
                  </th>
                  <th scope="col" className="py-1.5 pr-3 font-medium">
                    {gt("Observed")}
                  </th>
                  <th scope="col" className="py-1.5 pr-3 font-medium">
                    {gt("Fired")}
                  </th>
                  <th scope="col" className="py-1.5 font-medium">
                    {gt("Status")}
                  </th>
                  {onDeclareIncident && (
                    <th scope="col" className="py-1.5 font-medium sr-only">
                      {gt("Declare")}
                    </th>
                  )}
                </tr>
              </thead>
              <tbody>
                {events.map((e) => (
                  <tr key={e.id} className="border-t border-border">
                    <td className="py-1.5 pr-3 text-on-surface">{e.ruleName}</td>
                    <td className="py-1.5 pr-3 text-on-surface-secondary">{e.resourceName}</td>
                    <td className="py-1.5 pr-3 text-on-surface-secondary">
                      {Number(e.observedValue.toFixed(2))}
                    </td>
                    <td className="py-1.5 pr-3 text-on-surface-secondary">
                      {formatWhen(e.firedAt)}
                    </td>
                    <td className="py-1.5">
                      {e.status === "firing" ? (
                        <span className="text-danger">{gt("firing")}</span>
                      ) : (
                        <span className="text-success">
                          {gt("resolved")}
                          {e.resolvedAt ? ` ${formatWhen(e.resolvedAt)}` : ""}
                        </span>
                      )}
                    </td>
                    {onDeclareIncident && (
                      <td className="py-1.5 text-right">
                        <button
                          type="button"
                          onClick={() =>
                            onDeclareIncident({
                              title: gt("{rule} firing on {resource}", {
                                rule: e.ruleName,
                                resource: e.resourceName,
                              }),
                              summary: gt('Metric alert "{rule}" fired at {value}.', {
                                rule: e.ruleName,
                                value: Number(e.observedValue.toFixed(2)),
                              }),
                              resourceIds: [e.resourceId],
                              startedAt: e.firedAt,
                            })
                          }
                          className="px-2 py-1 rounded-lg text-xs text-danger hover:bg-surface-sunken transition-colors"
                        >
                          {gt("Declare incident")}
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {editing && (
        <MetricAlertRuleModal
          initialInput={editing.initial}
          client={client}
          onSave={save}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}

function ruleToInput(rule: MetricAlertRuleWithStatus): MetricAlertRuleInput {
  return {
    name: rule.name,
    pluginId: rule.pluginId,
    resourceTypeId: rule.resourceTypeId,
    tagKey: rule.tagKey,
    tagValue: rule.tagValue,
    metricKey: rule.metricKey,
    comparator: rule.comparator,
    threshold: rule.threshold,
    forMinutes: rule.forMinutes,
    cooldownMinutes: rule.cooldownMinutes,
    enabled: rule.enabled,
  };
}
