/**
 * The alert routing rules editor.
 *
 * Rules rather than a trigger matrix on every Slack channel and Teams webhook
 * row: a matrix can only answer "does this channel take this kind of alert";
 * a rule answers "which alerts, under what conditions, to whom, when,
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
 *   written anything. Editing it is what turns it into a real rule (the client
 *   -side `default` id is dropped on save and the server mints one) so the
 *   "Start from the default" button is a shortcut rather than a gate.
 */
import { useEffect, useState } from "react";
import { useGT } from "gt-react";
import {
  validateAlertRule,
  type AlertRule,
  type AlertRulesResponse,
} from "@infrawrench/client-core";

import { useSettingsHost } from "./host.js";

import { RuleCard } from "./alert-routing/RuleCard.js";
import { AlertDeliveriesPanel } from "./alert-routing/AlertDeliveriesPanel.js";

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
  const gt = useGT();
  const { api } = useSettingsHost();
  // The effects below depend on `apiGet`, not on `api`. The host's `api`
  // container is rebuilt whenever the host value is (a permission refresh does
  // it), while the method itself is stable on both platforms: module-level on
  // web, `useMemo`'d on desktop. Depending on the container would refetch the
  // whole rule list every time permissions settle.
  const apiGet = api.get;
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
        const res = await apiGet<AlertRulesResponse>(`/api/org/${orgId}/alert-rules`);
        if (cancelled) return;
        setData(res);
        setRules(res.rules);
        setDirty(false);
      } catch {
        // Non-admins get a 403: hide the section rather than show an error,
        // matching how the drift and digest settings behave.
        if (!cancelled) setForbidden(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [apiGet, orgId, reloadNonce]);

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
      setError(e instanceof Error ? e.message : gt("Failed to save rules"));
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
      setError(e instanceof Error ? e.message : gt("Failed to save rules"));
    } finally {
      setSaving(false);
    }
  }

  if (forbidden || !data) return null;

  const firstProblem = rules.map(validateAlertRule).find(Boolean) ?? null;

  return (
    <section className="border border-border rounded-xl p-5 space-y-4">
      <div>
        <h2 className="text-sm font-semibold text-on-surface-secondary">{gt("Alert routing")}</h2>
        <p className="text-xs text-on-surface-muted mt-1">
          {gt(
            "Rules are evaluated top to bottom. The first rule that matches decides where an alert goes, unless it says to keep going — so put the specific rules above the general ones.",
          )}
        </p>
      </div>

      {data.usingDefaults && !dirty && (
        <div className="rounded-lg border border-border/60 bg-surface-muted/40 p-3 space-y-2">
          <p className="text-xs text-on-surface-secondary">
            {gt(
              "You haven't written any rules, so alerts follow the default: everything except drift goes to every connected channel and to mobile push.",
            )}
          </p>
          <button
            type="button"
            onClick={() => void handleAdopt()}
            disabled={saving}
            className="text-xs text-info hover:text-info-strong disabled:opacity-50"
          >
            {gt("Start from the default and edit it")}
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
          className="text-xs text-info hover:text-info-strong"
        >
          {gt("Add rule")}
        </button>
        {dirty && (
          <>
            <button
              type="button"
              onClick={() => void handleSave()}
              disabled={saving || firstProblem !== null}
              className="rounded-md bg-blue-600 px-3 py-1.5 text-xs text-white disabled:opacity-50"
            >
              {saving ? gt("Saving…") : gt("Save rules")}
            </button>
            <button
              type="button"
              onClick={() => setReloadNonce((n) => n + 1)}
              disabled={saving}
              className="text-xs text-on-surface-tertiary hover:text-on-surface-secondary"
            >
              {gt("Discard changes")}
            </button>
          </>
        )}
      </div>

      {error && <p className="text-xs text-danger">{error}</p>}

      <AlertDeliveriesPanel orgId={orgId} />
    </section>
  );
}
