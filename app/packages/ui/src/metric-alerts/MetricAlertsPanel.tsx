import { useCallback, useEffect, useState } from "react";
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
    if (!window.confirm(`Delete metric alert rule "${rule.name}"?`)) return;
    await client.deleteRule?.(rule.id);
    reload();
  };

  return (
    <div className="space-y-6">
      <section>
        <div className="flex items-center justify-between mb-2">
          <div>
            <h2 className="text-base font-semibold text-on-surface">Metric alerts</h2>
            <p className="text-xs text-on-surface-faint">
              Threshold rules over collected metrics — "CPU &gt; 90% for 15 minutes". Rules select
              resources by query, so new resources are covered automatically.
            </p>
          </div>
          {canWrite && (
            <button
              type="button"
              onClick={() => setEditing({ ruleId: null, initial: DEFAULT_METRIC_ALERT_INPUT })}
              className="px-3 py-1.5 rounded-lg text-sm bg-blue-600 hover:bg-blue-500 text-white transition-colors"
            >
              New rule
            </button>
          )}
        </div>

        {error && <p className="text-sm text-danger">{error}</p>}
        {rules === null && !error && (
          <p className="text-sm text-on-surface-faint">Loading rules…</p>
        )}
        {rules !== null && rules.length === 0 && (
          <p className="text-sm text-on-surface-faint">
            No rules yet. Create one to get paged when a metric crosses a threshold.
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
                        rule.firingCount > 0 ? "Firing" : rule.enabled ? "Healthy" : "Disabled"
                      }
                    />
                    <span className="text-sm font-medium text-on-surface truncate">
                      {rule.name}
                    </span>
                    {rule.firingCount > 0 && (
                      <span className="text-xs text-danger">
                        firing on {rule.firingCount} resource{rule.firingCount === 1 ? "" : "s"}
                      </span>
                    )}
                    {!rule.enabled && (
                      <span className="text-xs text-on-surface-faint">disabled</span>
                    )}
                  </div>
                  <p className="text-xs text-on-surface-secondary truncate">
                    {describeMetricAlertCondition(rule)} · {describeMetricAlertSelector(rule)} ·
                    matches {rule.matchingResourceCount} resource
                    {rule.matchingResourceCount === 1 ? "" : "s"}
                  </p>
                </div>
                {canWrite && (
                  <div className="flex items-center gap-1.5 shrink-0">
                    <button
                      type="button"
                      onClick={() => void toggle(rule)}
                      className="px-2 py-1 rounded-lg text-xs text-on-surface-secondary hover:bg-surface-sunken transition-colors"
                    >
                      {rule.enabled ? "Disable" : "Enable"}
                    </button>
                    <button
                      type="button"
                      onClick={() => setEditing({ ruleId: rule.id, initial: ruleToInput(rule) })}
                      className="px-2 py-1 rounded-lg text-xs text-on-surface-secondary hover:bg-surface-sunken transition-colors"
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      onClick={() => void remove(rule)}
                      className="px-2 py-1 rounded-lg text-xs text-danger hover:bg-surface-sunken transition-colors"
                    >
                      Delete
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h3 className="text-sm font-semibold text-on-surface mb-2">Recent firings</h3>
        {events === null && <p className="text-sm text-on-surface-faint">Loading…</p>}
        {events !== null && events.length === 0 && (
          <p className="text-sm text-on-surface-faint">No firings yet.</p>
        )}
        {events !== null && events.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-on-surface-faint">
                  <th scope="col" className="py-1.5 pr-3 font-medium">
                    Rule
                  </th>
                  <th scope="col" className="py-1.5 pr-3 font-medium">
                    Resource
                  </th>
                  <th scope="col" className="py-1.5 pr-3 font-medium">
                    Observed
                  </th>
                  <th scope="col" className="py-1.5 pr-3 font-medium">
                    Fired
                  </th>
                  <th scope="col" className="py-1.5 font-medium">
                    Status
                  </th>
                  {onDeclareIncident && (
                    <th scope="col" className="py-1.5 font-medium sr-only">
                      Declare
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
                        <span className="text-danger">firing</span>
                      ) : (
                        <span className="text-success">
                          resolved{e.resolvedAt ? ` ${formatWhen(e.resolvedAt)}` : ""}
                        </span>
                      )}
                    </td>
                    {onDeclareIncident && (
                      <td className="py-1.5 text-right">
                        <button
                          type="button"
                          onClick={() =>
                            onDeclareIncident({
                              title: `${e.ruleName} firing on ${e.resourceName}`,
                              summary: `Metric alert "${e.ruleName}" fired at ${Number(e.observedValue.toFixed(2))}.`,
                              resourceIds: [e.resourceId],
                              startedAt: e.firedAt,
                            })
                          }
                          className="px-2 py-1 rounded-lg text-xs text-red-400 hover:bg-surface-sunken transition-colors"
                        >
                          Declare incident
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
